const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const Institution = require("./domain/Institution");
const AuditEntry = require("./domain/AuditEntry");
const { InstitutionRepository } = require("./infrastructure/InstitutionRepository");
const AuditLogger = require("./infrastructure/AuditLogger");
const AuditRepository = require("./infrastructure/AuditRepository");
const SecretsManager = require("./security/SecretsManager");
const { InstitutionService } = require("./application/InstitutionService");
const { EntityAuthService } = require("./application/EntityAuthService");
const Package = require("./domain/Package");
const PackageRepository = require("./infrastructure/PackageRepository");
const EventPublisher = require("./infrastructure/EventPublisher");
const { BrokerConsumer } = require("./infrastructure/BrokerConsumer");
const { PackageService } = require("./application/PackageService");
const PackageEventReconciler = require("./application/PackageEventReconciler");
const { makePackageProcessedHandler, makeOfficialRequestHandler } = require("./interfaces/eventHandlers");

async function main() {
  await mongoose.connect(env.mongoUri);
  // El indice UNICO del NIT debe existir ANTES de aceptar registros: sin el, dos registros simultaneos del mismo NIT
  // podrian crear dos instituciones.
  await Promise.all([Institution.init(), AuditEntry.init(), Package.init()]);

  if (!env.registrationToken) {
    logger.warn("REGISTRATION_TOKEN no esta configurado: el registro de instituciones es ABIERTO (cualquiera puede registrar una entidad). Ver docs/SEGURIDAD.md, seccion 10.");
  }

  // Llavero de firma de los tokens INSTITUCIONALES (ADR-07). Es una llave propia de este servicio: la de ciudadanos
  // (JWT_SECRET, de ms-identidad) aqui solo VERIFICA tokens de ciudadano (HU-06.2) y nunca firma con ella. Solo se
  // registran los ids de llave, nunca el secreto.
  const entitySecrets = new SecretsManager({ active: env.entityJwtSecret, previous: env.entityJwtSecretPrevious });
  logger.info("jwt.llavero_entidades", entitySecrets.status());

  const institutionRepository = new InstitutionRepository();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });

  const institutionService = new InstitutionService({ institutionRepository, auditLogger });
  const entityAuthService = new EntityAuthService({
    institutionRepository,
    secrets: entitySecrets,
    auditLogger,
    accessExpiresIn: env.entityAccessExpiresIn,
    maxAttempts: env.entityMaxAttempts,
    lockMs: env.entityLockMs,
  });

  // HU-06.2: paquetes documentales. Los tokens de ciudadano solo se VERIFICAN aqui (llave de ms-identidad).
  const secrets = new SecretsManager({ active: env.jwtSecret, previous: env.jwtSecretPrevious });
  const packageRepository = new PackageRepository();
  const eventPublisher = new EventPublisher(env.rabbitUri);
  const packageService = new PackageService({
    packageRepository,
    institutionService,
    eventPublisher,
    auditLogger,
    maxDocumentos: env.packages.maxDocumentos,
    eventPublishTimeoutMs: env.eventPublishTimeoutMs,
  });
  if (env.packages.reconcileIntervalMs > 0) {
    new PackageEventReconciler({ packageRepository, packageService, minAgeMs: env.packages.reconcileMinAgeMs }).start(env.packages.reconcileIntervalMs);
  }
  // Respuesta de ms-documentos (que predeclara la cola). Reconecta solo; sin broker el servicio arranca igual.
  // HU-06.4: resolver el NIT de una solicitud del documento oficial (la cola la predeclara ms-documentos).
  const consumers = [
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-comparticion.paquete-procesado", routingKey: "paquete.procesado", handler: makePackageProcessedHandler({ packageService }) }),
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-comparticion.solicitud-oficial-creada", routingKey: "solicitud_oficial.creada", handler: makeOfficialRequestHandler({ institutionService, eventPublisher, timeoutMs: env.eventPublishTimeoutMs }) }),
  ];
  for (const consumer of consumers) {
    consumer.start().catch((err) => {
      logger.error("consumidor.inicio_fallido", { queue: consumer.queue, err });
      consumer._scheduleReconnect();
    });
  }

  const app = buildApp({
    institutionService,
    entityAuthService,
    registrationToken: env.registrationToken,
    isReady: () => mongoose.connection.readyState === 1 && consumers.every((c) => Boolean(c.channel)),
    packageService,
    secrets,
    issuer: env.jwtIssuer,
    entitySecrets,
    auditLogger,
  });
  app.listen(env.port, () => logger.info("ms-comparticion escuchando", { port: env.port, registroAbierto: !env.registrationToken }));
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-comparticion", { err });
  process.exit(1);
});
