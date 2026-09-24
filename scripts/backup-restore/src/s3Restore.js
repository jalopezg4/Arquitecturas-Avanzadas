const fs = require("fs");
const path = require("path");
const { HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command, PutObjectCommand } = require("@aws-sdk/client-s3");
const { sha256 } = require("./hash");

/** El bucket destino ya tiene objetos: restaurar encima podria mezclar/pisar datos reales (p. ej. carpeta-documentos). */
class BucketNotEmptyError extends Error {
  constructor(bucket) {
    super(`el bucket destino "${bucket}" ya tiene objetos: no se restaura encima sin --force (podria mezclarse con datos reales)`);
    this.name = "BucketNotEmptyError";
  }
}

/**
 * Crea el bucket destino si no existe. Si YA existe y tiene al menos un objeto, se niega a continuar salvo
 * `force`. No se basa en el nombre del bucket (una convencion se puede olvidar u omitir): comprueba lo que
 * REALMENTE hay alli, igual que la proteccion equivalente para Mongo (ver mongoRestoreVerify.js).
 */
async function ensureEmptyBucket(client, Bucket, { force = false } = {}) {
  try {
    await client.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket }));
    return;
  }
  if (force) return;
  const res = await client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 }));
  if ((res.Contents || []).length > 0) throw new BucketNotEmptyError(Bucket);
}

/**
 * Restaura cada objeto del manifest, pero SOLO tras comprobar la integridad LOCAL del backup: que el
 * archivo exista, que su tamano y SHA-256 coincidan con lo que el propio backup registro. Si el archivo
 * local esta corrupto/ausente, o si falla la subida, se registra en `errors` y se CONTINUA con los demas
 * (nunca se aborta todo el restore por un objeto).
 */
async function restoreObjects(client, Bucket, objectsDir, manifestObjects) {
  const restored = [];
  const errors = [];

  for (const entry of manifestObjects) {
    try {
      const localPath = path.join(objectsDir, entry.localFile);
      if (!fs.existsSync(localPath)) throw new Error(`archivo local ausente: ${entry.localFile}`);
      const buf = fs.readFileSync(localPath);
      if (buf.length !== entry.size) throw new Error(`tamano local (${buf.length}) no coincide con el manifest (${entry.size}): backup corrupto`);
      if (sha256(buf) !== entry.sha256) throw new Error("sha256 local no coincide con el manifest: backup corrupto");

      await client.send(
        new PutObjectCommand({ Bucket, Key: entry.key, Body: buf, ContentType: entry.contentType || undefined, Metadata: entry.metadata || undefined })
      );
      restored.push(entry.key);
    } catch (err) {
      errors.push({ key: entry.key, error: err.message });
    }
  }
  return { restored, errors };
}

module.exports = { ensureEmptyBucket, restoreObjects, BucketNotEmptyError };
