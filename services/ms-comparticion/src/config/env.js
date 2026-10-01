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
// HU-06.2: aqui solo se VERIFICAN los tokens de ciudadano (los firma ms-identidad). Mismo valor de desarrollo que alla.
const INSECURE_DEV_JWT_SECRET = "solo-para-desarrollo-local-nunca-usar-en-despliegue"; // secret-scan:allow
const toInt = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

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
  // HU-06.2: el ciudadano arma y envia paquetes documentales con SU token (lo firma ms-identidad con JWT_SECRET; aqui
  // solo se verifica, nunca se firma). Debe ser la misma llave de ms-identidad y distinta de ENTITY_JWT_SECRET.
  jwtSecret: process.env.JWT_SECRET || (isLocal ? INSECURE_DEV_JWT_SECRET : ""),
  jwtSecretPrevious: list(process.env.JWT_SECRET_PREVIOUS),
  jwtIssuer: process.env.JWT_ISSUER || "ms-identidad",
  rabbitUri: process.env.RABBITMQ_URI || "amqp://localhost:5672",
  eventPublishTimeoutMs: toInt(process.env.EVENT_PUBLISH_TIMEOUT_MS, 3000),
  packages: {
    // HU-06.2: tope de documentos por paquete (el issue pide que no sea ilimitado).
    maxDocumentos: toInt(process.env.MAX_DOCUMENTOS_PAQUETE, 20),
    // Reenvio de `paquete.creado` que no se pudo publicar (0 lo desactiva).
    reconcileIntervalMs: toInt(process.env.RECONCILE_INTERVAL_MS, 60000),
    reconcileMinAgeMs: toInt(process.env.RECONCILE_MIN_AGE_MS, 60000),
  },
};

assertValidConfig(config);

module.exports = config;
