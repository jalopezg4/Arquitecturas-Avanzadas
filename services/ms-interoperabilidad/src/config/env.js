require("dotenv").config();
const { assertValidConfig, ConfigError } = require("./ConfigValidator");

// Falla cerrado, igual que los demas servicios: sin NODE_ENV no se asume desarrollo.
if (!process.env.NODE_ENV) {
  throw new ConfigError(["NODE_ENV es obligatorio: development, test, staging o production"]);
}
const nodeEnv = process.env.NODE_ENV;
const isLocal = nodeEnv === "development" || nodeEnv === "test";

const toInt = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));
const toBool = (value) => value === "true" || value === "1";

const config = {
  nodeEnv,
  isLocal,
  port: process.env.PORT || 3004,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-interoperabilidad",
  govCarpetaBaseUrl: process.env.GOVCARPETA_BASE_URL || "https://govcarpeta-apis-4905ff3c005b.herokuapp.com",
  httpTimeoutMs: toInt(process.env.GOVCARPETA_TIMEOUT_MS, 10000),
  // Nuestro propio operador: nunca puede ser el destino de una transferencia.
  operatorId: process.env.OPERATOR_ID || "",
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
