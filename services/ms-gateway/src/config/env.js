require("dotenv").config();
const { assertValidConfig, ConfigError } = require("./ConfigValidator");

// Falla cerrado, igual que ms-identidad: sin NODE_ENV no se asume desarrollo.
if (!process.env.NODE_ENV) {
  throw new ConfigError(["NODE_ENV es obligatorio: development, test, staging o production"]);
}
const nodeEnv = process.env.NODE_ENV;
const isLocal = nodeEnv === "development" || nodeEnv === "test";

// DEBE ser el mismo valor que en ms-identidad para que, en desarrollo local, el gateway acepte los tokens que ese servicio firma.
const INSECURE_DEV_JWT_SECRET = "solo-para-desarrollo-local-nunca-usar-en-despliegue"; // secret-scan:allow
// Igual, pero para los tokens INSTITUCIONALES (ADR-07): el mismo valor de desarrollo que usa ms-comparticion.
const INSECURE_DEV_ENTITY_JWT_SECRET = "solo-para-desarrollo-local-entidades-nunca-en-despliegue"; // secret-scan:allow

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const toBool = (value) => value === "true" || value === "1";

const config = {
  nodeEnv,
  isLocal,
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || (isLocal ? INSECURE_DEV_JWT_SECRET : ""),
  jwtSecretPrevious: list(process.env.JWT_SECRET_PREVIOUS),
  jwtIssuer: process.env.JWT_ISSUER || "ms-identidad",
  // ADR-07: llave con la que ms-comparticion FIRMA los tokens institucionales; aqui solo se VERIFICAN. Es distinta
  // de JWT_SECRET a proposito. En local cae a la misma llave de desarrollo que usa ms-comparticion; sin ella, las
  // rutas marcadas `actor: "entidad"` responden 401 (fallan cerrado).
  entityJwtSecret: process.env.ENTITY_JWT_SECRET || (isLocal ? INSECURE_DEV_ENTITY_JWT_SECRET : ""),
  entityJwtSecretPrevious: list(process.env.ENTITY_JWT_SECRET_PREVIOUS),
  entityJwtIssuer: process.env.ENTITY_JWT_ISSUER || "ms-comparticion",
  // Servicios destino. Cada microservicio nuevo agrega aqui su URL y una linea en src/routes.js.
  upstreams: {
    IDENTIDAD_URL: process.env.IDENTIDAD_URL || "http://localhost:3001",
    DOCUMENTOS_URL: process.env.DOCUMENTOS_URL || "http://localhost:3002",
    COMPARTICION_URL: process.env.COMPARTICION_URL || "http://localhost:3005",
  },
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS) || 10000,
  tls: {
    certPath: process.env.TLS_CERT_PATH || "",
    keyPath: process.env.TLS_KEY_PATH || "",
    caPath: process.env.TLS_CA_PATH || "",
    required: toBool(process.env.REQUIRE_TLS),
  },
};

assertValidConfig(config);

module.exports = config;
