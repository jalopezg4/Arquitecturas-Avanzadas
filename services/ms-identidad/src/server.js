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

  // Aviso de configuracion: se emite una vez al arrancar (sin traza), no dentro de una peticion.
  logger.warn(
    "GovCarpeta validateCitizen: el Swagger no documenta 200/204 (sin schema). Verificado " +
      "empiricamente el 2026-09-17 que un documento nunca registrado devuelve 204 (=> disponible); " +
      "aun no se ha confirmado con un caso real que 200 signifique 'ya existe'. " +
      "Ver docs/GOVCARPETA_CONTRATO.md.",
    { availableStatus: env.govCarpetaAvailableStatus }
  );

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
