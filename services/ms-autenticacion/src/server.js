const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const AuthenticationAttempt = require("./domain/AuthenticationAttempt");
const AttemptRepository = require("./infrastructure/AttemptRepository");
const AuditLogger = require("./infrastructure/AuditLogger");
const AuditRepository = require("./infrastructure/AuditRepository");
const ObjectStorageAdapter = require("./infrastructure/ObjectStorageAdapter");
const GovCarpetaClient = require("./infrastructure/GovCarpetaClient");
const EventPublisher = require("./infrastructure/EventPublisher");
const { BrokerConsumer } = require("./infrastructure/BrokerConsumer");
const { PresignedUrlService } = require("./application/PresignedUrlService");
const { AuthenticationService, staleClaimMsFor } = require("./application/AuthenticationService");
const { makeEventHandlers } = require("./interfaces/eventHandlers");

async function main() {
  await mongoose.connect(env.mongoUri);
  // El indice UNICO por eventId debe existir ANTES de consumir: sin el, dos entregas simultaneas de la misma solicitud
  // podrian llamar dos veces a GovCarpeta.
  await AuthenticationAttempt.init();

  const authenticationService = new AuthenticationService({
    attemptRepository: new AttemptRepository(),
    presignedUrlService: new PresignedUrlService({ storage: ObjectStorageAdapter.fromConfig(env.s3), ttlSeconds: env.presignedAuthTtlSeconds }),
    govCarpetaClient: new GovCarpetaClient(env.govCarpeta),
    eventPublisher: new EventPublisher(env.rabbitUri),
    auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
    eventPublishTimeoutMs: env.eventPublishTimeoutMs,
    staleClaimMs: staleClaimMsFor(env.govCarpeta),
  });
  const handlers = makeEventHandlers({ authenticationService });

  // ms-documentos ya predeclara esta cola (EventPublisher.js): las solicitudes esperan aunque este servicio este caido
  // (matriz de degradacion). Aqui se declara IGUAL (solo durable) o el broker rechaza la redeclaracion.
  // prefetch 1: cada solicitud puede tardar varios segundos en GovCarpeta; no tiene sentido acaparar mensajes.
  const consumer = new BrokerConsumer({
    uri: env.rabbitUri,
    queue: "ms-autenticacion.autenticacion-solicitada",
    routingKey: "documento.autenticacion_solicitada",
    handler: handlers.autenticacionSolicitada,
    prefetch: 1,
  });
  consumer.start().catch((err) => {
    logger.error("consumidor.inicio_fallido", { queue: consumer.queue, err });
    consumer._scheduleReconnect();
  });

  const app = buildApp({ isReady: () => mongoose.connection.readyState === 1 && Boolean(consumer.channel) });
  app.listen(env.port, () => logger.info("ms-autenticacion escuchando", { port: env.port, govCarpeta: env.govCarpeta.baseUrl }));
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-autenticacion", { err });
  process.exit(1);
});
