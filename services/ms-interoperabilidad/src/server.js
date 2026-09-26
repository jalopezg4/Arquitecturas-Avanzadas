const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const Operator = require("./domain/Operator");
const DirectoryState = require("./domain/DirectoryState");
const Citizen = require("./domain/Citizen");
const Transfer = require("./domain/Transfer");
const { OperatorRepository } = require("./infrastructure/OperatorRepository");
const { GovCarpetaDirectoryClient } = require("./infrastructure/GovCarpetaDirectoryClient");
const CitizenRepository = require("./infrastructure/CitizenRepository");
const { BrokerConsumer } = require("./infrastructure/BrokerConsumer");
const { OperatorDirectoryService } = require("./application/OperatorDirectoryService");
const { makeCitizenRegisteredHandler } = require("./interfaces/eventHandlers");

/** Arranca un consumidor que reconecta solo: si RabbitMQ no esta al arrancar, el servicio NO cae. */
function startConsumer(consumer) {
  consumer.start().catch((err) => {
    logger.error("consumidor.inicio_fallido", { queue: consumer.queue, err });
    consumer._scheduleReconnect();
  });
  return consumer;
}

async function main() {
  await mongoose.connect(env.mongoUri);
  // Los indices unicos deben existir ANTES de escribir (un refresco no puede duplicar operadores; dos transferencias
  // vivas del mismo ciudadano no pueden coexistir).
  await Promise.all([Operator.init(), DirectoryState.init(), Citizen.init(), Transfer.init()]);

  if (!env.operatorId) {
    logger.warn("OPERATOR_ID no esta configurado -- no se podra impedir una transferencia hacia este mismo operador ni afiliar/desafiliar en GovCarpeta. Ver docs/OPERADOR_MINTIC.md.");
  }

  const directory = new OperatorDirectoryService({
    client: new GovCarpetaDirectoryClient({ baseUrl: env.govCarpetaBaseUrl, timeoutMs: env.httpTimeoutMs }),
    repository: new OperatorRepository(),
    ownOperatorId: env.operatorId,
    ttlMs: env.directory.ttlMinutes * 60000,
    maxStaleMs: env.directory.maxStaleMinutes * 60000,
    minForcedRefreshMs: env.directory.minForcedRefreshSeconds * 1000,
    urlPolicy: { allowPrivate: env.directory.allowPrivateUrls, requireHttps: env.directory.requireHttpsUrls },
  });

  // Precalienta la copia local. Es de mejor esfuerzo: si GovCarpeta no responde el servicio arranca igual y el
  // directorio se pedira cuando haga falta (con la politica de refresco).
  directory.refresh().catch((err) => logger.warn("directorio.precalentamiento_fallido", { err }));

  // HU-05c: copia local del ciudadano (cedula, nombre, correo, direccion unica) para poder transferirlo.
  const citizenRepository = new CitizenRepository();
  const consumers = [
    startConsumer(new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-interoperabilidad.ciudadano-registrado", routingKey: "ciudadano.registrado", handler: makeCitizenRegisteredHandler({ citizenRepository }) })),
  ];

  const app = buildApp({ isReady: () => mongoose.connection.readyState === 1 && consumers.every((c) => Boolean(c.channel)) });
  app.listen(env.port, () => logger.info("ms-interoperabilidad escuchando", { port: env.port }));
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-interoperabilidad", { err });
  process.exit(1);
});
