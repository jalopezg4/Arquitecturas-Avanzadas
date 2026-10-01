require("dotenv").config();
const { assertValidConfig, ConfigError } = require("./ConfigValidator");

// Falla cerrado, igual que el resto de servicios: sin NODE_ENV no se asume desarrollo.
if (!process.env.NODE_ENV) {
  throw new ConfigError(["NODE_ENV es obligatorio: development, test, staging o production"]);
}
const nodeEnv = process.env.NODE_ENV;
const isLocal = nodeEnv === "development" || nodeEnv === "test";

const toBool = (value) => value === "true" || value === "1";
const toInt = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

const config = {
  nodeEnv,
  isLocal,
  port: process.env.PORT || 3007,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-autenticacion",
  rabbitUri: process.env.RABBITMQ_URI || "amqp://localhost:5672",
  // Object storage de ms-documentos: aqui SOLO se firman URLs de lectura (nunca se sube ni se borra nada). En
  // despliegue estas credenciales deberian ser de solo lectura sobre el bucket.
  s3: {
    endpoint: process.env.S3_ENDPOINT || (isLocal ? "http://localhost:9000" : ""),
    // Host con el que GovCarpeta alcanza al storage: la URL se firma para ese host. Debe ser publico en internet.
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || "",
    region: process.env.S3_REGION || "us-east-1",
    bucket: process.env.S3_BUCKET || "carpeta-documentos",
    accessKeyId: process.env.S3_ACCESS_KEY_ID || (isLocal ? "minioadmin" : ""), // secret-scan:allow
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || (isLocal ? "minioadmin" : ""), // secret-scan:allow
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === undefined ? true : toBool(process.env.S3_FORCE_PATH_STYLE),
    connectTimeoutMs: toInt(process.env.S3_CONNECT_TIMEOUT_MS, 1500),
    requestTimeoutMs: toInt(process.env.S3_REQUEST_TIMEOUT_MS, 2500),
  },
  // HU-04 / ADR-06: vigencia exacta de la URL que se entrega a GovCarpeta (tope 15 minutos).
  presignedAuthTtlSeconds: toInt(process.env.PRESIGNED_URL_AUTH_TTL_SECONDS, 15 * 60),
  govCarpeta: {
    baseUrl: process.env.GOVCARPETA_BASE_URL || "https://govcarpeta-apis-4905ff3c005b.herokuapp.com",
    timeoutMs: toInt(process.env.GOVCARPETA_TIMEOUT_MS, 10000),
    // HU-04: maximo 3 intentos con espera creciente antes de dar la autenticacion por fallida.
    maxAttempts: toInt(process.env.GOVCARPETA_MAX_ATTEMPTS, 3),
    baseDelayMs: toInt(process.env.GOVCARPETA_BASE_DELAY_MS, 1000),
  },
  eventPublishTimeoutMs: toInt(process.env.EVENT_PUBLISH_TIMEOUT_MS, 3000),
};

assertValidConfig(config);

module.exports = config;
