const crypto = require("crypto");
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { MAX_DOWNLOAD_TTL_SECONDS } = require("../config/ConfigValidator");

/**
 * Object storage S3-compatible (MinIO en desarrollo; S3 u otro proveedor en despliegue). Es el UNICO lugar que
 * conoce el SDK: el resto del servicio depende de esta interfaz (newKey, put, delete, presignedGetUrl), asi que
 * cambiar de proveedor no toca la logica de negocio.
 *
 * Solo la CLAVE del objeto se guarda en Mongo, nunca el binario.
 */
class ObjectStorageAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.bucket
   * @param {object} opts.client        cliente S3 (inyectable en pruebas)
   * @param {object} [opts.presignClient] cliente con el endpoint PUBLICO, para firmar URLs que abrira el navegador
   */
  constructor({ bucket, client, presignClient }) {
    this.bucket = bucket;
    this.client = client;
    this.presignClient = presignClient || client;
  }

  static fromConfig(s3) {
    const base = {
      region: s3.region,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      forcePathStyle: s3.forcePathStyle,
      // Fallar RAPIDO. El SDK reintenta por defecto durante mucho mas que el plazo del gateway; si el storage cae, el
      // cliente vería un 504 mientras la carga sigue viva y termina creando un documento cuando el storage vuelve
      // (un reintento del cliente lo duplicaria). ms-documentos debe rendirse ANTES que el gateway.
      maxAttempts: 2,
      // throwOnRequestTimeout: SIN esto el SDK solo AVISA al pasarse del plazo y deja la peticion viva (la causa del "fantasma").
      requestHandler: { connectionTimeout: s3.connectTimeoutMs || 1500, requestTimeout: s3.requestTimeoutMs || 2500, throwOnRequestTimeout: true },
    };
    const client = new S3Client({ ...base, ...(s3.endpoint ? { endpoint: s3.endpoint } : {}) });
    const presignClient = s3.publicEndpoint ? new S3Client({ ...base, endpoint: s3.publicEndpoint }) : client;
    return new ObjectStorageAdapter({ bucket: s3.bucket, client, presignClient });
  }

  /**
   * Clave unica por ciudadano: `ciudadanos/<ciudadanoId>/<uuid>.pdf`. Se arma SOLO con el id del ciudadano (ya
   * validado por el token) y un UUID aleatorio: nada que envie el usuario (nombre de archivo, titulo) entra en la
   * clave, asi que no hay recorrido de rutas ni colisiones entre ciudadanos.
   */
  newKey(ciudadanoId) {
    if (typeof ciudadanoId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(ciudadanoId)) throw new Error("ObjectStorageAdapter: ciudadanoId invalido para la clave");
    return `ciudadanos/${ciudadanoId}/${crypto.randomUUID()}.pdf`;
  }

  async put(key, body, contentType) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** URL de descarga con vigencia limitada (ADR-06: la descarga propia del ciudadano, como maximo 1 hora). */
  async presignedGetUrl(key, ttlSeconds) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_DOWNLOAD_TTL_SECONDS) {
      throw new Error(`ObjectStorageAdapter: la vigencia debe ser un entero entre 1 y ${MAX_DOWNLOAD_TTL_SECONDS} segundos`);
    }
    return getSignedUrl(this.presignClient, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSeconds });
  }

  /** Solo desarrollo local: crea el bucket si no existe (en despliegue el bucket lo provisiona la infraestructura). */
  async ensureBucket() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }
}

module.exports = ObjectStorageAdapter;
