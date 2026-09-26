const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");

async function main() {
  await mongoose.connect(env.mongoUri);

  const app = buildApp({ isReady: () => mongoose.connection.readyState === 1 });
  app.listen(env.port, () => logger.info("ms-autenticacion escuchando", { port: env.port }));
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-autenticacion", { err });
  process.exit(1);
});
