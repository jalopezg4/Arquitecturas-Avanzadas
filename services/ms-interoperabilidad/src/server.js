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
const { makeCitizenRegisteredHandler, makeFolderExportedHandler, makeReceiverHandlers } = require("./interfaces/eventHandlers");
const { TransferReceiverService } = require("./application/TransferReceiverService");
const { TransferRepository } = require("./infrastructure/TransferRepository");
const GovCarpetaCitizenClient = require("./infrastructure/GovCarpetaCitizenClient");
const { PeerOperatorClient } = require("./infrastructure/PeerOperatorClient");
const EventPublisher = require("./infrastructure/EventPublisher");
const AuditLogger = require("./infrastructure/AuditLogger");
const AuditRepository = require("./infrastructure/AuditRepository");
const SecretsManager = require("./security/SecretsManager");
const { TransferSagaService } = require("./application/TransferSagaService");
const TransferSweeper = require("./application/TransferSweeper");

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

  // HU-05c: transferencia de ciudadanos entre operadores.
  const secrets = new SecretsManager({ active: env.jwtSecret, previous: env.jwtSecretPrevious });
  const citizenRepository = new CitizenRepository();
  const transferRepository = new TransferRepository();
  const eventPublisher = new EventPublisher(env.rabbitUri);
  const govCarpetaClient = new GovCarpetaCitizenClient({ baseUrl: env.govCarpetaBaseUrl, operatorId: env.operatorId, operatorName: env.operatorName, timeoutMs: env.httpTimeoutMs });
  const peerClient = new PeerOperatorClient({ timeoutMs: env.transfer.peerTimeoutMs, allowPrivate: env.directory.allowPrivateUrls, requireHttps: env.directory.requireHttpsUrls });
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const sagaService = new TransferSagaService({
    transferRepository,
    citizenRepository,
    directory,
    govCarpetaClient,
    peerClient,
    eventPublisher,
    auditLogger,
    publicBaseUrl: env.publicBaseUrl,
    confirmTimeoutMs: env.transfer.confirmTimeoutMs,
    maxSendAttempts: env.transfer.maxSendAttempts,
    stepTimeoutMs: env.transfer.stepTimeoutMs,
    eventPublishTimeoutMs: env.eventPublishTimeoutMs,
  });

  const receiverService = new TransferReceiverService({
    transferRepository,
    citizenRepository,
    peerClient,
    eventPublisher,
    auditLogger,
    urlPolicy: { allowPrivate: env.directory.allowPrivateUrls, requireHttps: env.directory.requireHttpsUrls },
    maxDocuments: env.transfer.maxDocuments,
    stepTimeoutMs: env.transfer.stepTimeoutMs,
    eventPublishTimeoutMs: env.eventPublishTimeoutMs,
  });
  const receiverHandlers = makeReceiverHandlers({ receiverService });

  // Colas que predeclaran los publicadores (ms-identidad, ms-documentos): aqui se declaran IGUAL (solo durables).
  const consumers = [
    startConsumer(new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-interoperabilidad.ciudadano-registrado", routingKey: "ciudadano.registrado", handler: makeCitizenRegisteredHandler({ citizenRepository }) })),
    startConsumer(new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-interoperabilidad.carpeta-exportada", routingKey: "transferencia.carpeta_exportada", handler: makeFolderExportedHandler({ sagaService, maxDocuments: env.transfer.maxDocuments }) })),
    startConsumer(new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-interoperabilidad.documentos-importados", routingKey: "transferencia.documentos_importados", handler: receiverHandlers.documentosImportados })),
    startConsumer(new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-interoperabilidad.ciudadano-importado", routingKey: "transferencia.ciudadano_registrado", handler: receiverHandlers.ciudadanoImportado })),
  ];

  // Plazos y reintentos de la saga: sin esto, un mensaje perdido o un reinicio dejarian una transferencia colgada.
  if (env.transfer.sweepIntervalMs > 0) {
    new TransferSweeper({ transferRepository, reviewers: { saliente: sagaService, entrante: receiverService } }).start(env.transfer.sweepIntervalMs);
  }

  const app = buildApp({
    isReady: () => mongoose.connection.readyState === 1 && consumers.every((c) => Boolean(c.channel)),
    sagaService,
    receiverService,
    secrets,
    issuer: env.jwtIssuer,
  });
  app.listen(env.port, () => logger.info("ms-interoperabilidad escuchando", { port: env.port }));
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-interoperabilidad", { err });
  process.exit(1);
});
