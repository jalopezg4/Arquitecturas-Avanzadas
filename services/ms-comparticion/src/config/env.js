require("dotenv").config();
const { assertValidConfig, ConfigError } = require("./ConfigValidator");

// Falla cerrado, igual que los demas servicios: sin NODE_ENV no se asume desarrollo.
if (!process.env.NODE_ENV) {
  throw new ConfigError(["NODE_ENV es obligatorio: development, test, staging o production"]);
}
const nodeEnv = process.env.NODE_ENV;
const isLocal = nodeEnv === "development" || nodeEnv === "test";

// Llave de desarrollo para los tokens INSTITUCIONALES. Es distinta de la de ciudadanos a proposito (ADR-07):
// si fueran la misma, un token de entidad valdria donde solo debe valer uno de ciudadano y al reves.
const INSECURE_DEV_ENTITY_JWT_SECRET = "solo-para-desarrollo-local-entidades-nunca-en-despliegue"; // secret-scan:allow

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const config = {
  nodeEnv,
  isLocal,
  port: process.env.PORT || 3005,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-comparticion",
  // Opcional. Si se define, POST /api/v1/institutions exige el encabezado x-registration-token con este valor
  // (el operador se lo entrega a cada institucion al afiliarla). Vacio = registro abierto, como pide el issue.
  registrationToken: process.env.REGISTRATION_TOKEN || "",
  // Llave con la que ESTE servicio firma los tokens institucionales (ADR-07). Fuera de dev/test es obligatoria.
  entityJwtSecret: process.env.ENTITY_JWT_SECRET || (isLocal ? INSECURE_DEV_ENTITY_JWT_SECRET : ""),
  // Llaves anteriores que siguen VERIFICANDO durante una rotacion (separadas por coma), igual que JWT_SECRET_PREVIOUS.
  entityJwtSecretPrevious: list(process.env.ENTITY_JWT_SECRET_PREVIOUS),
  entityAccessExpiresIn: process.env.ENTITY_ACCESS_EXPIRES_IN || "15m",
  // Proteccion contra fuerza bruta en el login institucional, misma politica que HU-02 para ciudadanos.
  entityMaxAttempts: Number(process.env.ENTITY_MAX_ATTEMPTS) || 5,
  entityLockMs: Number(process.env.ENTITY_LOCK_MS) || 15 * 60 * 1000,
};

assertValidConfig(config);

module.exports = config;
