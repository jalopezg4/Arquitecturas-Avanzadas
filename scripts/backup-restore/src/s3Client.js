const { S3Client } = require("@aws-sdk/client-s3");

/**
 * Cliente S3, con las MISMAS variables de entorno que ya usa `services/ms-documentos/src/config/env.js`:
 * no se inventan nombres nuevos (S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
 * S3_FORCE_PATH_STYLE).
 *
 * `overrides` permite apuntar a un MinIO DISTINTO del que ya esta en el entorno (p. ej. el destino de una
 * restauracion, que debe ser un bucket/endpoint aislado) sin tocar las variables globales del proceso.
 */
function buildS3Client(overrides = {}) {
  const endpoint = overrides.endpoint || process.env.S3_ENDPOINT || "http://localhost:9000";
  const region = overrides.region || process.env.S3_REGION || "us-east-1";
  const accessKeyId = overrides.accessKeyId || process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = overrides.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY;
  const forcePathStyle =
    overrides.forcePathStyle !== undefined
      ? overrides.forcePathStyle
      : process.env.S3_FORCE_PATH_STYLE === undefined
        ? true
        : process.env.S3_FORCE_PATH_STYLE !== "false";

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("S3_ACCESS_KEY_ID y S3_SECRET_ACCESS_KEY son obligatorios (las mismas variables que usa ms-documentos)");
  }
  return new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle });
}

/** Bucket de ORIGEN por defecto: el mismo que usa ms-documentos (S3_BUCKET, o "carpeta-documentos"). */
function sourceBucket() {
  return process.env.S3_BUCKET || "carpeta-documentos";
}

module.exports = { buildS3Client, sourceBucket };
