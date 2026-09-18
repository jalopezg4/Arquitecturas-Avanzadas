require("dotenv").config();

const nodeEnv = process.env.NODE_ENV || "development";
const isLocal = nodeEnv === "development" || nodeEnv === "test";

const INSECURE_DEV_JWT_SECRET = "solo-para-desarrollo-local-nunca-usar-en-despliegue";

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (!isLocal) {
    // Fuera de dev/test, un secreto ausente no puede caer silenciosamente a un valor
    // predecible: cualquier token firmado con un default conocido seria falsificable.
    throw new Error("JWT_SECRET es requerido cuando NODE_ENV no es development/test");
  }
  jwtSecret = INSECURE_DEV_JWT_SECRET;
}

module.exports = {
  port: process.env.PORT || 3001,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-identidad",
  rabbitUri: process.env.RABBITMQ_URI || "amqp://localhost:5672",
  govCarpetaBaseUrl: process.env.GOVCARPETA_BASE_URL || "https://govcarpeta-apis-4905ff3c005b.herokuapp.com",
  operatorId: process.env.OPERATOR_ID || "",
  operatorName: process.env.OPERATOR_NAME || "Operador Ciudadano EAFIT",
  // Ver nota en GovCarpetaClient: interpretacion de validateCitizen NO confirmada por el
  // Swagger. Permite invertirla (200 <-> 204) sin tocar codigo si la prueba empirica lo exige.
  govCarpetaAvailableStatus: Number(process.env.GOVCARPETA_AVAILABLE_STATUS) || 204,
  jwtSecret,
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
};
