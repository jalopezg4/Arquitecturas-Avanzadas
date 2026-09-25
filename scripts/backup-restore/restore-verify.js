#!/usr/bin/env node
/**
 * HT-02 -- restaura un backup generado por backup.js en destinos AISLADOS y verifica que la restauracion
 * sea identica al backup: no solo "no hubo error", sino contenido comparado (SHA-256/EJSON), no solo
 * conteos.
 *
 *   node restore-verify.js --backup=<archivo.tar.gz> --mongo-uri=<uri> --minio-bucket=<bucket>
 *
 * SEGURIDAD (deliberado, no un descuido):
 *   --mongo-uri y --minio-bucket NO TIENEN VALOR POR DEFECTO. Deben indicarse explicitamente -- a
 *   diferencia de backup.js (leer no es peligroso), aqui un default silencioso podria apuntar sin querer
 *   al Mongo/MinIO de desarrollo. Ademas, ANTES de escribir nada, el script comprueba que el destino este
 *   REALMENTE vacio de datos del proyecto (no adivina por el texto de la URI/nombre del bucket): si el
 *   Mongo destino ya tiene alguna de las 5 bases del proyecto, o el bucket destino ya tiene objetos, se
 *   NIEGA a continuar salvo --force.
 *
 * Opciones:
 *   --backup=<archivo>         .tar.gz generado por backup.js (obligatorio)
 *   --mongo-uri=<uri>           Mongo DESTINO (obligatorio salvo --skip-mongo; SIN valor por defecto)
 *   --minio-bucket=<nombre>      bucket DESTINO (obligatorio salvo --skip-minio; SIN valor por defecto)
 *   --minio-endpoint=<url>        endpoint del MinIO destino (por defecto: S3_ENDPOINT del entorno)
 *   --force                        omite la comprobacion de "destino vacio" (usar con cuidado)
 *   --skip-mongo / --skip-minio    restaura/verifica solo una parte
 *   --help
 *
 * Salida:
 *   0 = restaurado y verificado SIN diferencias
 *   1 = fallo fatal, O verificacion con diferencias (fallo de integridad)
 *   (no se usa 2 aqui: si la verificacion encuentra algo, SIEMPRE es 1, nunca un "exito parcial" silencioso
 *   -- ver README, seccion "codigos de salida", para la razon de este diseno)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseArgs } = require("./src/args");
const { readManifest, validateManifest } = require("./src/manifest");
const { unpack } = require("./src/archive");
const { buildS3Client } = require("./src/s3Client");
const { ensureEmptyBucket, restoreObjects, BucketNotEmptyError } = require("./src/s3Restore");
const { verifyObjects } = require("./src/s3Verify");
const { assertPristineTarget, restoreFromFile, verifyFingerprint, MongoDestinationNotEmptyError } = require("./src/mongoRestoreVerify");
const { sha256 } = require("./src/hash");

const HELP = `Uso: node restore-verify.js --backup=<archivo.tar.gz> [opciones]
  --backup=<archivo>          .tar.gz generado por backup.js (obligatorio)
  --mongo-uri=<uri>            Mongo DESTINO (obligatorio salvo --skip-mongo; SIN valor por defecto)
  --minio-bucket=<nombre>       bucket DESTINO (obligatorio salvo --skip-minio; SIN valor por defecto)
  --minio-endpoint=<url>         endpoint del MinIO destino (por defecto: S3_ENDPOINT del entorno)
  --force                         omite la comprobacion de que el destino este vacio (usar con cuidado)
  --skip-mongo                     no restaurar/verificar MongoDB
  --skip-minio                     no restaurar/verificar MinIO
  --help                            muestra esta ayuda

Salida: 0 = verificado sin diferencias | 1 = fallo fatal o de integridad`;

async function main() {
  const { flags, values, unknown } = parseArgs(process.argv.slice(2), {
    flags: ["force", "skip-mongo", "skip-minio", "help"],
    values: ["backup", "mongo-uri", "minio-bucket", "minio-endpoint"],
  });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  if (unknown.length) {
    console.error(`Opcion desconocida: ${unknown.join(" ")}\n\n${HELP}`);
    return 1;
  }
  if (!values.backup) {
    console.error(`Falta --backup=<archivo.tar.gz>\n\n${HELP}`);
    return 1;
  }
  if (!flags["skip-mongo"] && !values["mongo-uri"]) {
    console.error("Falta --mongo-uri (obligatorio, SIN valor por defecto a proposito: evita restaurar sobre el Mongo de desarrollo por accidente)");
    return 1;
  }
  if (!flags["skip-minio"] && !values["minio-bucket"]) {
    console.error("Falta --minio-bucket (obligatorio, SIN valor por defecto a proposito: evita restaurar sobre carpeta-documentos por accidente)");
    return 1;
  }

  const backupFile = path.resolve(values.backup);
  if (!fs.existsSync(backupFile)) {
    console.error(`No existe: ${backupFile}`);
    return 1;
  }

  const workParent = fs.mkdtempSync(path.join(os.tmpdir(), "ht02-restore-"));
  let integrityFailed = false;
  let fatal = false;
  let workDir;

  try {
    workDir = unpack(backupFile, workParent);
  } catch (err) {
    console.error(`No se pudo extraer el backup: ${err.message}`);
    fs.rmSync(workParent, { recursive: true, force: true });
    return 1;
  }

  let manifest;
  try {
    manifest = readManifest(workDir);
  } catch (err) {
    console.error(`No se pudo leer manifest.json: ${err.message}`);
    fs.rmSync(workParent, { recursive: true, force: true });
    return 1;
  }
  const manifestProblems = validateManifest(manifest);
  if (manifestProblems.length) {
    console.error("Manifest invalido:\n" + manifestProblems.map((p) => `  - ${p}`).join("\n"));
    fs.rmSync(workParent, { recursive: true, force: true });
    return 1;
  }

  // ---------- MinIO ----------
  if (!flags["skip-minio"]) {
    try {
      const client = buildS3Client({ endpoint: values["minio-endpoint"] });
      const bucket = values["minio-bucket"];
      await ensureEmptyBucket(client, bucket, { force: flags.force });

      const objectsDir = path.join(workDir, "objects");
      const { restored, errors } = await restoreObjects(client, bucket, objectsDir, manifest.minio.objects);
      console.log(`MinIO: ${restored.length} objeto(s) restaurados, ${errors.length} con error`);
      errors.forEach((e) => console.error(`  - ${e.key}: ${e.error}`));

      const verify = await verifyObjects(client, bucket, manifest.minio.objects);
      if (!verify.ok) {
        integrityFailed = true;
        console.error(`MinIO: VERIFICACION FALLO (${verify.problems.length} diferencia(s)):`);
        verify.problems.forEach((p) => console.error(`  - ${JSON.stringify(p)}`));
      } else {
        console.log(`MinIO: verificacion OK (${verify.counts.destino} objetos, ${verify.bytes.destino} bytes, coincide con el backup)`);
      }
    } catch (err) {
      fatal = true;
      if (err instanceof BucketNotEmptyError) console.error(`MinIO: ${err.message}`);
      else console.error(`MinIO: fallo fatal -- ${err.message}`);
    }
  } else {
    console.log("MinIO: omitido (--skip-minio)");
  }

  // ---------- Mongo ----------
  if (!flags["skip-mongo"]) {
    if (!manifest.mongo || manifest.mongo.error) {
      console.error("Mongo: el backup no tiene un volcado utilizable (se omitio con --skip-mongo al respaldar, o el respaldo fallo)");
      fatal = true;
    } else {
      try {
        const mongoUri = values["mongo-uri"];
        await assertPristineTarget(mongoUri, { force: flags.force });

        const archivePath = path.join(workDir, "mongo.archive.gz");
        if (!fs.existsSync(archivePath)) throw new Error("mongo.archive.gz no esta en el backup extraido");
        const buf = fs.readFileSync(archivePath);
        if (buf.length !== manifest.mongo.size) {
          throw new Error(`tamano de mongo.archive.gz (${buf.length}) no coincide con el manifest (${manifest.mongo.size}): backup corrupto`);
        }
        if (sha256(buf) !== manifest.mongo.sha256) throw new Error("sha256 de mongo.archive.gz no coincide con el manifest: backup corrupto");

        await restoreFromFile(mongoUri, archivePath);
        console.log("Mongo: mongorestore OK");

        const verify = await verifyFingerprint(mongoUri, manifest.mongo.databases);
        if (!verify.ok) {
          integrityFailed = true;
          console.error(`Mongo: VERIFICACION FALLO (${verify.problems.length} diferencia(s)):`);
          verify.problems.forEach((p) => console.error(`  - ${JSON.stringify(p)}`));
        } else {
          console.log(`Mongo: verificacion OK (${Object.keys(manifest.mongo.databases).length} base(s), contenido identico via EJSON)`);
        }
      } catch (err) {
        fatal = true;
        if (err instanceof MongoDestinationNotEmptyError) console.error(`Mongo: ${err.message}`);
        else console.error(`Mongo: fallo fatal -- ${err.message}`);
      }
    }
  } else {
    console.log("Mongo: omitido (--skip-mongo)");
  }

  fs.rmSync(workParent, { recursive: true, force: true });

  if (fatal) {
    console.error("\nResultado: FALLO FATAL");
    return 1;
  }
  if (integrityFailed) {
    console.error("\nResultado: FALLO DE INTEGRIDAD (la restauracion no coincide con el backup)");
    return 1;
  }
  console.log("\nResultado: OK (restauracion verificada, sin diferencias)");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("ERROR FATAL:", err);
    process.exit(1);
  });
