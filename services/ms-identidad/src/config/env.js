require("dotenv").config();
const { assertValidConfig, ConfigError } = require("./ConfigValidator");

// Falla cerrado: si NODE_ENV no esta definido NO se asume "development". Un despliegue que olvide
// la variable arrancaria con llaves conocidas y sin exigir TLS. Para desarrollo local, definirlo
// en .env (ver .env.example); docker-compose y jest ya lo definen.
if (!process.env.NODE_ENV) {
  throw new ConfigError(["NODE_ENV es obligatorio: development, test, staging o production"]);
}
const nodeEnv = process.env.NODE_ENV;
const isLocal = nodeEnv === "development" || nodeEnv === "test";

const INSECURE_DEV_JWT_SECRET = "solo-para-desarrollo-local-nunca-usar-en-despliegue"; // secret-scan:allow

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const toBool = (value) => value === "true" || value === "1";
const toInt = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

// Fuera de dev/test un secreto ausente no puede caer a un valor predecible: el validador lo rechaza.
const jwtSecret = process.env.JWT_SECRET || (isLocal ? INSECURE_DEV_JWT_SECRET : "");

const config = {
  nodeEnv,
  isLocal,
  port: process.env.PORT || 3001,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-identidad",
  rabbitUri: process.env.RABBITMQ_URI || "amqp://localhost:5672",
  govCarpetaBaseUrl: process.env.GOVCARPETA_BASE_URL || "https://govcarpeta-apis-4905ff3c005b.herokuapp.com",
  operatorId: process.env.OPERATOR_ID || "",
  operatorName: process.env.OPERATOR_NAME || "MiFolio", // debe coincidir con el nombre registrado en GovCarpeta
  // Ver nota en GovCarpetaClient: interpretacion de validateCitizen verificada empiricamente
  // (204 = disponible). Permite invertirla sin tocar codigo si el sandbox cambia.
  govCarpetaAvailableStatus: Number(process.env.GOVCARPETA_AVAILABLE_STATUS) || 204,
  jwtSecret,
  // Llaves anteriores que siguen VERIFICANDO tokens durante una rotacion (separadas por coma).
  jwtSecretPrevious: list(process.env.JWT_SECRET_PREVIOUS),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  tls: {
    certPath: process.env.TLS_CERT_PATH || "",
    keyPath: process.env.TLS_KEY_PATH || "",
    // Si se define, se exige certificado de cliente firmado por esta CA (mTLS entre servicios).
    caPath: process.env.TLS_CA_PATH || "",
    required: toBool(process.env.REQUIRE_TLS),
  },
  presignedUrl: {
    authTtlSeconds: toInt(process.env.PRESIGNED_URL_AUTH_TTL_SECONDS, 15 * 60),
    downloadTtlSeconds: toInt(process.env.PRESIGNED_URL_DOWNLOAD_TTL_SECONDS, 60 * 60),
  },
};

assertValidConfig(config);

module.exports = config;
