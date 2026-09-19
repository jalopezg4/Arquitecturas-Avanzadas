const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const CitizenRepository = require("./infrastructure/CitizenRepository");
const GovCarpetaClient = require("./infrastructure/GovCarpetaClient");
const EventPublisher = require("./infrastructure/EventPublisher");
const AuditLogger = require("./infrastructure/AuditLogger");
const AuditRepository = require("./infrastructure/AuditRepository");
const { CitizenSagaService } = require("./application/CitizenSagaService");

async function main() {
  await mongoose.connect(env.mongoUri);

  if (!env.operatorId) {
    logger.warn("OPERATOR_ID no esta configurado -- registerCitizen/authenticateDocument fallaran contra GovCarpeta real. Completar HU-11 primero.");
  }

  const citizenRepository = new CitizenRepository();
  const govCarpetaClient = new GovCarpetaClient({
    baseUrl: env.govCarpetaBaseUrl,
    operatorId: env.operatorId,
    operatorName: env.operatorName,
    availableStatus: env.govCarpetaAvailableStatus,
  });
  const eventPublisher = new EventPublisher(env.rabbitUri);

  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });

  const citizenSagaService = new CitizenSagaService({
    citizenRepository,
    govCarpetaClient,
    eventPublisher,
    auditLogger,
  });

  const app = buildApp({ citizenSagaService });
  app.listen(env.port, () => {
    logger.info("ms-identidad escuchando", { port: env.port });
  });
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-identidad", { err });
  process.exit(1);
});
