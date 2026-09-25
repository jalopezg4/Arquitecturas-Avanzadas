require("dotenv").config();
const { assertValidConfig, ConfigError } = require("./ConfigValidator");

// Falla cerrado, igual que los demas servicios: sin NODE_ENV no se asume desarrollo.
if (!process.env.NODE_ENV) {
  throw new ConfigError(["NODE_ENV es obligatorio: development, test, staging o production"]);
}
const nodeEnv = process.env.NODE_ENV;
const isLocal = nodeEnv === "development" || nodeEnv === "test";

// Mismo valor de desarrollo que usan ms-comparticion, ms-documentos y ms-gateway (deben coincidir para que un
// token institucional emitido por ms-comparticion se verifique aqui).
const INSECURE_DEV_ENTITY_JWT_SECRET = "solo-para-desarrollo-local-entidades-nunca-en-despliegue"; // secret-scan:allow

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const toInt = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

const config = {
  nodeEnv,
  isLocal,
  port: process.env.PORT || 3006,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-analitica",
  // ADR-07: llave con la que ms-comparticion FIRMA los tokens institucionales; aqui solo se VERIFICAN (HU-07.2
  // es la unica API de este servicio hasta ahora y esta protegida con ella, asi que -- a diferencia de
  // ms-documentos, donde todavia es opcional -- aqui es obligatoria fuera de local).
  entityJwtSecret: process.env.ENTITY_JWT_SECRET || (isLocal ? INSECURE_DEV_ENTITY_JWT_SECRET : ""),
  entityJwtSecretPrevious: list(process.env.ENTITY_JWT_SECRET_PREVIOUS),
  entityJwtIssuer: process.env.ENTITY_JWT_ISSUER || "ms-comparticion",
  // HU-07.1: endpoint interno de agregacion de metadatos (mismo nombre de variable que ya usa ms-gateway para
  // el mismo servicio). Nunca se hardcodea: en Docker Compose sera el nombre DNS del servicio.
  documentosUrl: process.env.DOCUMENTOS_URL || "http://localhost:3002",
  // Timeout de esta llamada sincrona interna. Sin reintentos (decision explicita del MVP): un timeout aqui es
  // mas probable una caida real que una falla transitoria, y reintentar solo amplificaria carga.
  documentsAnalyticsTimeoutMs: toInt(process.env.DOCUMENTS_ANALYTICS_TIMEOUT_MS, 5000),
};

assertValidConfig(config);

module.exports = config;
