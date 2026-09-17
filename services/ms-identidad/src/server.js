const mongoose = require("mongoose");
const env = require("./config/env");
const buildApp = require("./app");
const CitizenRepository = require("./infrastructure/CitizenRepository");
const GovCarpetaClient = require("./infrastructure/GovCarpetaClient");
const EventPublisher = require("./infrastructure/EventPublisher");
const { CitizenSagaService } = require("./application/CitizenSagaService");

async function main() {
  await mongoose.connect(env.mongoUri);

  if (!env.operatorId) {
    // eslint-disable-next-line no-console
    console.warn(
      "OPERATOR_ID no esta configurado -- registerCitizen/authenticateDocument fallaran contra GovCarpeta real. Completar HU-11 primero."
    );
  }

  const citizenRepository = new CitizenRepository();
  const govCarpetaClient = new GovCarpetaClient({
    baseUrl: env.govCarpetaBaseUrl,
    operatorId: env.operatorId,
    operatorName: env.operatorName,
  });
  const eventPublisher = new EventPublisher(env.rabbitUri);

  const citizenSagaService = new CitizenSagaService({ citizenRepository, govCarpetaClient, eventPublisher });

  const app = buildApp({ citizenSagaService });
  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`ms-identidad escuchando en puerto ${env.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fallo al iniciar ms-identidad:", err);
  process.exit(1);
});
