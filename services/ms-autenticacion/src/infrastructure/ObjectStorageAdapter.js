const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { MAX_AUTH_TTL_SECONDS } = require("../config/ConfigValidator");

/**
 * Acceso al object storage de ms-documentos, reducido a lo que este servicio necesita: firmar una URL de LECTURA con
 * vigencia limitada (HU-04). No sube, no borra y no lee el binario: a GovCarpeta se le entrega la URL, nunca el archivo
 * (RNF-13, RNF-14). Mismo SDK y misma configuracion que ObjectStorageAdapter de ms-documentos.
 */
class ObjectStorageAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.bucket
   * @param {object} opts.client        cliente S3 (inyectable en pruebas)
   * @param {object} [opts.presignClient] cliente con el endpoint PUBLICO: la URL la abre GovCarpeta desde internet
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
      maxAttempts: 2,
      requestHandler: { connectionTimeout: s3.connectTimeoutMs || 1500, requestTimeout: s3.requestTimeoutMs || 2500, throwOnRequestTimeout: true },
    };
    const client = new S3Client({ ...base, ...(s3.endpoint ? { endpoint: s3.endpoint } : {}) });
    const presignClient = s3.publicEndpoint ? new S3Client({ ...base, endpoint: s3.publicEndpoint }) : client;
    return new ObjectStorageAdapter({ bucket: s3.bucket, client, presignClient });
  }

  /** URL de lectura con vigencia limitada (ADR-06: la que ve GovCarpeta, como maximo 15 minutos). Se firma localmente. */
  async presignedGetUrl(key, ttlSeconds) {
    if (typeof key !== "string" || !key) throw new Error("ObjectStorageAdapter: clave de objeto invalida");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_AUTH_TTL_SECONDS) {
      throw new Error(`ObjectStorageAdapter: la vigencia debe ser un entero entre 1 y ${MAX_AUTH_TTL_SECONDS} segundos`);
    }
    return getSignedUrl(this.presignClient, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSeconds });
  }
}

module.exports = ObjectStorageAdapter;
