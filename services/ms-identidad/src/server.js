const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const CitizenRepository = require("./infrastructure/CitizenRepository");
const RefreshSessionRepository = require("./infrastructure/RefreshSessionRepository");
const GovCarpetaClient = require("./infrastructure/GovCarpetaClient");
const EventPublisher = require("./infrastructure/EventPublisher");
const AuditLogger = require("./infrastructure/AuditLogger");
const AuditRepository = require("./infrastructure/AuditRepository");
const SecretsManager = require("./security/SecretsManager");
const createServer = require("./transport/createServer");
const { CitizenSagaService } = require("./application/CitizenSagaService");
const { AuthService } = require("./application/AuthService");
const PendingRegistrationReconciler = require("./application/PendingRegistrationReconciler");
const { CitizenTransferService } = require("./application/CitizenTransferService");
const { AccountActivationService } = require("./application/AccountActivationService");
const Citizen = require("./domain/Citizen");
const { BrokerConsumer } = require("./infrastructure/BrokerConsumer");
const { makeTransferHandlers } = require("./interfaces/eventHandlers");

async function main() {
  await mongoose.connect(env.mongoUri);

  if (!env.operatorId) {
    logger.warn("OPERATOR_ID no esta configurado -- registerCitizen/authenticateDocument fallaran contra GovCarpeta real. Registrar el operador una vez por ambiente: npm run register:operator (ver docs/OPERADOR_MINTIC.md).");
  }

  // Aviso de configuracion: se emite una vez al arrancar (sin traza), no dentro de una peticion.
  logger.warn(
    "GovCarpeta validateCitizen: el Swagger no documenta 200/204 (sin schema). Verificado " +
      "empiricamente el 2026-09-17 que un documento nunca registrado devuelve 204 (=> disponible); " +
      "aun no se ha confirmado con un caso real que 200 signifique 'ya existe'. " +
      "Ver docs/GOVCARPETA_CONTRATO.md.",
    { availableStatus: env.govCarpetaAvailableStatus }
  );

  // Llavero de firma JWT (lo usa el login, HU-02). Solo se registran los ids de llave, nunca el secreto.
  const secrets = new SecretsManager({ active: env.jwtSecret, previous: env.jwtSecretPrevious });
  logger.info("jwt.llavero", secrets.status());

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
    eventPublishTimeoutMs: env.eventPublishTimeoutMs,
  });

  if (env.reconcile.intervalMs > 0) {
    new PendingRegistrationReconciler({ citizenRepository, govCarpetaClient, eventPublisher, auditLogger, minAgeMs: env.reconcile.minAgeMs }).start(env.reconcile.intervalMs);
  }

  const refreshSessionRepository = new RefreshSessionRepository();

  // HU-05c: primeros consumidores de este servicio (antes solo publicaba). Las colas las predeclara
  // ms-interoperabilidad; reconectan solos y, si el broker no esta al arrancar, el servicio NO cae.
  const activationService = new AccountActivationService({
    citizenModel: Citizen,
    eventPublisher,
    auditLogger,
    ttlMs: env.activationTtlHours * 3600 * 1000,
    eventPublishTimeoutMs: env.eventPublishTimeoutMs,
  });
  const transferHandlers = makeTransferHandlers({
    citizenTransferService: new CitizenTransferService({ citizenRepository, refreshSessionRepository, govCarpetaClient, eventPublisher, auditLogger, accountActivationService: activationService, eventPublishTimeoutMs: env.eventPublishTimeoutMs }),
  });
  for (const consumer of [
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-identidad.ciudadano-transferido", routingKey: "ciudadano.transferido", handler: transferHandlers.ciudadanoTransferido }),
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-identidad.transferencia-registrar", routingKey: "transferencia.registrar_ciudadano", handler: transferHandlers.registrarCiudadano }),
  ]) {
    consumer.start().catch((err) => {
      logger.error("consumidor.inicio_fallido", { queue: consumer.queue, err });
      consumer._scheduleReconnect();
    });
  }

  const authService = new AuthService({
    citizenRepository,
    refreshSessionRepository,
    secrets,
    auditLogger,
    accessExpiresIn: env.jwtAccessExpiresIn,
    refreshExpiresIn: env.jwtRefreshExpiresIn,
  });

  const app = buildApp({ citizenSagaService, authService, secrets, activationService });
  const server = createServer(app, env.tls);
  server.listen(env.port, () => {
    const transport = env.tls.certPath ? (env.tls.caPath ? "mTLS" : "TLS") : "http";
    logger.info("ms-identidad escuchando", { port: env.port, transport });
  });
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-identidad", { err });
  process.exit(1);
});
