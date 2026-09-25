require("dotenv").config();
const { assertValidConfig, ConfigError } = require("./ConfigValidator");

// Falla cerrado, igual que ms-identidad: sin NODE_ENV no se asume desarrollo.
if (!process.env.NODE_ENV) {
  throw new ConfigError(["NODE_ENV es obligatorio: development, test, staging o production"]);
}
const nodeEnv = process.env.NODE_ENV;
const isLocal = nodeEnv === "development" || nodeEnv === "test";

// DEBE ser el mismo valor que en ms-identidad para que, en desarrollo local, este servicio acepte los tokens que ese firma.
const INSECURE_DEV_JWT_SECRET = "solo-para-desarrollo-local-nunca-usar-en-despliegue"; // secret-scan:allow
// Igual, pero para los tokens INSTITUCIONALES (ADR-07): el mismo valor de desarrollo que usa ms-comparticion.
const INSECURE_DEV_ENTITY_JWT_SECRET = "solo-para-desarrollo-local-entidades-nunca-en-despliegue"; // secret-scan:allow

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const toBool = (value) => value === "true" || value === "1";
const toInt = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

const config = {
  nodeEnv,
  isLocal,
  port: process.env.PORT || 3002,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-documentos",
  rabbitUri: process.env.RABBITMQ_URI || "amqp://localhost:5672",
  jwtSecret: process.env.JWT_SECRET || (isLocal ? INSECURE_DEV_JWT_SECRET : ""),
  jwtSecretPrevious: list(process.env.JWT_SECRET_PREVIOUS),
  jwtIssuer: process.env.JWT_ISSUER || "ms-identidad",
  // ADR-07: llave con la que ms-comparticion FIRMA los tokens institucionales; aqui solo se VERIFICARIAN.
  // Todavia no la usa ninguna ruta (la primera sera HU-10): es opcional, y si se define debe ser fuerte y
  // DISTINTA de JWT_SECRET. En local cae a la misma llave de desarrollo que usa ms-comparticion.
  entityJwtSecret: process.env.ENTITY_JWT_SECRET || (isLocal ? INSECURE_DEV_ENTITY_JWT_SECRET : ""),
  entityJwtSecretPrevious: list(process.env.ENTITY_JWT_SECRET_PREVIOUS),
  entityJwtIssuer: process.env.ENTITY_JWT_ISSUER || "ms-comparticion",
  // Object storage S3-compatible (MinIO en desarrollo, S3/Cloudinary/etc. en despliegue). Solo se guarda la CLAVE en Mongo.
  s3: {
    endpoint: process.env.S3_ENDPOINT || (isLocal ? "http://localhost:9000" : ""),
    // Endpoint con el que el NAVEGADOR alcanza al storage (las URLs prefirmadas se firman para ese host). En Docker el
    // servicio habla con `minio:9000` pero el usuario con `localhost:9000`.
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || "",
    region: process.env.S3_REGION || "us-east-1",
    bucket: process.env.S3_BUCKET || "carpeta-documentos",
    accessKeyId: process.env.S3_ACCESS_KEY_ID || (isLocal ? "minioadmin" : ""), // secret-scan:allow
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || (isLocal ? "minioadmin" : ""), // secret-scan:allow
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === undefined ? true : toBool(process.env.S3_FORCE_PATH_STYLE),
    // Plazos del cliente S3. Con 2 intentos, el peor caso (2 x (conexion + solicitud)) debe quedar por debajo del
    // plazo del gateway (UPSTREAM_TIMEOUT_MS, 10 s): si no, el cliente ve un 504 de una carga que luego se completa.
    connectTimeoutMs: toInt(process.env.S3_CONNECT_TIMEOUT_MS, 1500),
    requestTimeoutMs: toInt(process.env.S3_REQUEST_TIMEOUT_MS, 2500),
  },
  limits: {
    // Cuota de documentos NO certificados por ciudadano (RNF-04). Los certificados no cuentan.
    quotaNoCertificados: toInt(process.env.QUOTA_NO_CERTIFICADOS, 5),
    maxUploadBytes: toInt(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
    // HU-10: limite propio de la recepcion institucional, mas alto que el del ciudadano. El criterio de la historia
    // dice "sin limite de tamano" para certificados, pero el archivo se procesa en memoria (multer.memoryStorage):
    // sin tope, una sola peticion tumba el servicio. Se deja en el maximo que ya admite la politica (50 MB) y la
    // desviacion queda documentada en docs/SEGURIDAD.md, seccion 7.
    maxInboundBytes: toInt(process.env.MAX_INBOUND_UPLOAD_BYTES, 50 * 1024 * 1024),
  },
  presignedDownloadTtlSeconds: toInt(process.env.PRESIGNED_URL_DOWNLOAD_TTL_SECONDS, 60 * 60),
  // Cuanto espera la confirmacion del broker antes de responder igual (la notificacion no es camino critico, ADR-04).
  eventPublishTimeoutMs: toInt(process.env.EVENT_PUBLISH_TIMEOUT_MS, 3000),
  // Reenvio de eventos no publicados (0 desactiva el proceso). minAge evita reenviar uno cuya publicacion sigue en curso.
  reconcile: {
    intervalMs: toInt(process.env.RECONCILE_INTERVAL_MS, 60000),
    minAgeMs: toInt(process.env.RECONCILE_MIN_AGE_MS, 60000),
  },
  tls: {
    certPath: process.env.TLS_CERT_PATH || "",
    keyPath: process.env.TLS_KEY_PATH || "",
    caPath: process.env.TLS_CA_PATH || "",
    required: toBool(process.env.REQUIRE_TLS),
  },
};

assertValidConfig(config);

module.exports = config;
