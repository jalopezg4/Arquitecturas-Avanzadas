#!/usr/bin/env node
/**
 * HT-02 -- genera un backup autocontenido (.tar.gz) de MongoDB (instancia completa, `mongodump --archive
 * --gzip`) y del bucket de MinIO configurado.
 *
 *   node backup.js                                     backup completo (Mongo + MinIO)
 *   node backup.js --skip-mongo                         solo MinIO
 *   node backup.js --skip-minio                         solo Mongo
 *   node backup.js --out=/ruta/destino                  carpeta donde queda el .tar.gz (por defecto: cwd)
 *   node backup.js --mongo-uri="mongodb://host:27017"    instancia Mongo a respaldar (por defecto:
 *                                                         mongodb://host.docker.internal:27017 -- el
 *                                                         puerto que docker-compose.yml ya publica al host)
 *
 * Requiere Docker (para mongodump/mongorestore/mongosh, via la MISMA imagen `mongo:7` que ya usa el
 * proyecto -- no se instala nada nuevo) y `tar` (preinstalado en Linux/CI y en Git Bash de Windows).
 *
 * Variables de entorno (MinIO) -- EXACTAMENTE las mismas que ya usa services/ms-documentos:
 *   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE
 *
 * Salida:
 *   0 = backup limpio (Mongo y MinIO respaldados sin errores)
 *   1 = fallo fatal (no se pudo generar un backup utilizable)
 *   2 = backup generado, pero con errores PARCIALES registrados en el manifest (algunos objetos, o toda
 *       una de las dos partes, no se pudieron capturar). El backup NO aparenta estar completo si no lo esta.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseArgs } = require("./src/args");
const { newManifest, writeManifest } = require("./src/manifest");
const { buildS3Client, sourceBucket } = require("./src/s3Client");
const { backupObjects } = require("./src/s3Backup");
const { dumpToFile, captureFingerprint } = require("./src/mongoBackup");
const { sha256 } = require("./src/hash");
const { pack, INNER_DIR } = require("./src/archive");

const HELP = `Uso: node backup.js [opciones]
  --out=<dir>           carpeta donde dejar el .tar.gz (por defecto: directorio actual)
  --mongo-uri=<uri>      instancia Mongo a respaldar (por defecto: mongodb://host.docker.internal:27017)
  --skip-mongo           no respaldar MongoDB
  --skip-minio           no respaldar MinIO
  --help                 muestra esta ayuda

Variables de entorno (MinIO, iguales a services/ms-documentos):
  S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE

Salida: 0 completo | 1 fallo fatal | 2 completado con errores parciales (ver manifest.json dentro del backup)`;

async function main() {
  const { flags, values, unknown } = parseArgs(process.argv.slice(2), {
    flags: ["skip-mongo", "skip-minio", "help"],
    values: ["out", "mongo-uri"],
  });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  if (unknown.length) {
    console.error(`Opcion desconocida: ${unknown.join(" ")}\n\n${HELP}`);
    return 1;
  }

  const outDir = path.resolve(values.out || process.cwd());
  const mongoUri = values["mongo-uri"] || process.env.MONGO_URI || "mongodb://host.docker.internal:27017";

  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ht02-backup-"));
  const workDir = path.join(parentDir, INNER_DIR);
  fs.mkdirSync(workDir);
  const objectsDir = path.join(workDir, "objects");

  let partial = false;
  let fatal = false;
  const manifest = newManifest({ bucket: sourceBucket() });

  if (!flags["skip-minio"]) {
    try {
      const client = buildS3Client();
      const { objects, errors } = await backupObjects(client, sourceBucket(), objectsDir);
      manifest.minio.objects = objects;
      manifest.minio.errors = errors;
      if (errors.length) {
        partial = true;
        console.error(`MinIO: ${errors.length} objeto(s) con error (ver manifest):`);
        errors.forEach((e) => console.error(`  - ${e.key}: ${e.error}`));
      }
      console.log(`MinIO: ${objects.length} objeto(s) respaldados de "${sourceBucket()}"`);
    } catch (err) {
      fatal = true;
      manifest.minio.fatalError = err.message;
      console.error(`MinIO: fallo fatal -- ${err.message}`);
    }
  } else {
    console.log("MinIO: omitido (--skip-minio)");
  }

  if (!flags["skip-mongo"]) {
    try {
      const archivePath = path.join(workDir, "mongo.archive.gz");
      await dumpToFile(mongoUri, archivePath);
      const buf = fs.readFileSync(archivePath);
      const databases = await captureFingerprint(mongoUri);
      manifest.mongo = { size: buf.length, sha256: sha256(buf), databases };
      console.log(`Mongo: volcado OK (${buf.length} bytes), ${Object.keys(databases).length} base(s) con huella capturada`);
    } catch (err) {
      fatal = true;
      manifest.mongo = { error: err.message };
      console.error(`Mongo: fallo fatal -- ${err.message}`);
    }
  } else {
    console.log("Mongo: omitido (--skip-mongo)");
  }

  writeManifest(workDir, manifest);

  fs.mkdirSync(outDir, { recursive: true });
  const timestamp = manifest.generatedAt.replace(/[:.]/g, "-");
  const outFile = path.join(outDir, `ht02-backup-${timestamp}.tar.gz`);
  pack(workDir, outFile);
  fs.rmSync(parentDir, { recursive: true, force: true });

  console.log(`\nBackup: ${outFile}`);
  if (fatal) {
    console.error("Resultado: FALLO FATAL (backup incompleto o no generado)");
    return 1;
  }
  if (partial) {
    console.error("Resultado: EXITO PARCIAL (ver errores en el manifest dentro del backup)");
    return 2;
  }
  console.log("Resultado: OK");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("ERROR FATAL:", err);
    process.exit(1);
  });
