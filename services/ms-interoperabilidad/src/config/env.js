require("dotenv").config();
const { assertValidConfig, ConfigError } = require("./ConfigValidator");

// Falla cerrado, igual que los demas servicios: sin NODE_ENV no se asume desarrollo.
if (!process.env.NODE_ENV) {
  throw new ConfigError(["NODE_ENV es obligatorio: development, test, staging o production"]);
}
const nodeEnv = process.env.NODE_ENV;
const isLocal = nodeEnv === "development" || nodeEnv === "test";

// DEBE ser el mismo valor que en ms-identidad para que, en desarrollo local, este servicio acepte los tokens que ese firma.
const INSECURE_DEV_JWT_SECRET = "solo-para-desarrollo-local-nunca-usar-en-despliegue"; // secret-scan:allow

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const toInt = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));
const toBool = (value) => value === "true" || value === "1";

const config = {
  nodeEnv,
  isLocal,
  port: process.env.PORT || 3004,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-interoperabilidad",
  govCarpetaBaseUrl: process.env.GOVCARPETA_BASE_URL || "https://govcarpeta-apis-4905ff3c005b.herokuapp.com",
  httpTimeoutMs: toInt(process.env.GOVCARPETA_TIMEOUT_MS, 10000),
  // Nuestro propio operador: nunca puede ser el destino de una transferencia. Tambien es el que se registra ante
  // GovCarpeta cuando recibimos un ciudadano (HU-05c), con el MISMO nombre que se uso al darlo de alta (HU-11).
  operatorId: process.env.OPERATOR_ID || "",
  operatorName: process.env.OPERATOR_NAME || "MiFolio",
  rabbitUri: process.env.RABBITMQ_URI || "amqp://localhost:5672",
  // HU-05c: el ciudadano inicia su transferencia con su token de acceso (misma llave que ms-identidad, ADR-06).
  jwtSecret: process.env.JWT_SECRET || (isLocal ? INSECURE_DEV_JWT_SECRET : ""),
  jwtSecretPrevious: list(process.env.JWT_SECRET_PREVIOUS),
  jwtIssuer: process.env.JWT_ISSUER || "ms-identidad",
  // Direccion publica de ESTE operador: de aqui sale el `confirmAPI` que enviamos al destino. Debe ser la misma base
  // que se publico en GovCarpeta (HU-05b).
  publicBaseUrl: process.env.PUBLIC_BASE_URL || (isLocal ? "http://localhost:3000" : ""),
  eventPublishTimeoutMs: toInt(process.env.EVENT_PUBLISH_TIMEOUT_MS, 3000),
  transfer: {
    // HU-05c: cuanto se espera la confirmacion del destino antes de reenviar, y cuantos envios antes de dar la
    // transferencia por fallida (y compensar).
    confirmTimeoutMs: toInt(process.env.TRANSFER_CONFIRM_TIMEOUT_MS, 5 * 60 * 1000),
    maxSendAttempts: toInt(process.env.TRANSFER_MAX_SEND_ATTEMPTS, 3),
    // Cuanto se espera la respuesta de otro servicio nuestro (exportar/importar/registrar) antes de volver a pedirla.
    stepTimeoutMs: toInt(process.env.TRANSFER_STEP_TIMEOUT_MS, 2 * 60 * 1000),
    // Cada cuanto revisa las transferencias que esperan algo (reintentos y plazos). 0 lo desactiva.
    sweepIntervalMs: toInt(process.env.TRANSFER_SWEEP_INTERVAL_MS, 30000),
    // Tope de documentos por transferencia recibida (una lista sin limite es un abuso).
    maxDocuments: toInt(process.env.TRANSFER_MAX_DOCUMENTS, 500),
    // Plazo de las llamadas HTTP a otros operadores.
    peerTimeoutMs: toInt(process.env.TRANSFER_PEER_TIMEOUT_MS, 15000),
  },
  directory: {
    // Politica de refresco del directorio local (HU-05a). Ver docs/SEGURIDAD.md, seccion 9.
    ttlMinutes: toInt(process.env.OPERATOR_DIRECTORY_TTL_MINUTES, 60),
    maxStaleMinutes: toInt(process.env.OPERATOR_DIRECTORY_MAX_STALE_MINUTES, 24 * 60),
    minForcedRefreshSeconds: toInt(process.env.MIN_FORCED_REFRESH_SECONDS, 30),
    allowPrivateUrls: toBool(process.env.ALLOW_PRIVATE_OPERATOR_URLS),
    requireHttpsUrls: toBool(process.env.REQUIRE_HTTPS_OPERATOR_URLS),
  },
};

assertValidConfig(config);

module.exports = config;
