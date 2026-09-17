require("dotenv").config();

module.exports = {
  port: process.env.PORT || 3001,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-identidad",
  rabbitUri: process.env.RABBITMQ_URI || "amqp://localhost:5672",
  govCarpetaBaseUrl: process.env.GOVCARPETA_BASE_URL || "https://govcarpeta-apis-4905ff3c005b.herokuapp.com",
  operatorId: process.env.OPERATOR_ID || "",
  operatorName: process.env.OPERATOR_NAME || "Operador Ciudadano EAFIT",
  jwtSecret: process.env.JWT_SECRET || "cambiar-en-produccion",
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
};
