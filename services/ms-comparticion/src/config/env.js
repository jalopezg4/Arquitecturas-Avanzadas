require("dotenv").config();
const { assertValidConfig, ConfigError } = require("./ConfigValidator");

// Falla cerrado, igual que los demas servicios: sin NODE_ENV no se asume desarrollo.
if (!process.env.NODE_ENV) {
  throw new ConfigError(["NODE_ENV es obligatorio: development, test, staging o production"]);
}
const nodeEnv = process.env.NODE_ENV;
const isLocal = nodeEnv === "development" || nodeEnv === "test";

const config = {
  nodeEnv,
  isLocal,
  port: process.env.PORT || 3005,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-comparticion",
  // Opcional. Si se define, POST /api/v1/institutions exige el encabezado x-registration-token con este valor
  // (el operador se lo entrega a cada institucion al afiliarla). Vacio = registro abierto, como pide el issue.
  registrationToken: process.env.REGISTRATION_TOKEN || "",
};

assertValidConfig(config);

module.exports = config;
