const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const SecretsManager = require("./security/SecretsManager");
const createServer = require("./transport/createServer");
const ObjectStorageAdapter = require("./infrastructure/ObjectStorageAdapter");
const DocumentRepository = require("./infrastructure/DocumentRepository");
const FolderRepository = require("./infrastructure/FolderRepository");
const EventPublisher = require("./infrastructure/EventPublisher");
const AuditLogger = require("./infrastructure/AuditLogger");
const AuditRepository = require("./infrastructure/AuditRepository");
const { DocumentService } = require("./application/DocumentService");
const { InboundDocumentService } = require("./application/InboundDocumentService");
const { DocumentAnalyticsService } = require("./application/DocumentAnalyticsService");
const { SolicitudService } = require("./application/SolicitudService");
const SolicitudRepository = require("./infrastructure/SolicitudRepository");
const SolicitudEventReconciler = require("./application/SolicitudEventReconciler");
const EventReconciler = require("./application/EventReconciler");
const { DocumentAuthenticationService } = require("./application/DocumentAuthenticationService");
const AuthenticationRequestReconciler = require("./application/AuthenticationRequestReconciler");
const QuotaReconciler = require("./application/QuotaReconciler");
const { IdentityDocumentService } = require("./application/IdentityDocumentService");
const { SimulatedRegistraduriaDocumentClient } = require("./infrastructure/RegistraduriaDocumentClient");
const { BrokerConsumer } = require("./infrastructure/BrokerConsumer");
const { makeCitizenRegisteredHandler, makeAuthenticationResultHandlers, makeTransferHandlers, makeTransferImportHandlers, makePackageCreatedHandler, makeOfficialRequestResolvedHandler } = require("./interfaces/eventHandlers");
const { OfficialRequestService } = require("./application/OfficialRequestService");
const OfficialRequestReconciler = require("./application/OfficialRequestReconciler");
const OfficialRequest = require("./domain/OfficialRequest");
const { PackageDeliveryService } = require("./application/PackageDeliveryService");
const PackageGrant = require("./domain/PackageGrant");
const Folder = require("./domain/Folder");
const Document = require("./domain/Document");
const RevertedTransfer = require("./domain/RevertedTransfer");
const { TransferImportService } = require("./application/TransferImportService");
const { RemoteFileFetcher } = require("./infrastructure/RemoteFileFetcher");
const { TransferFolderService } = require("./application/TransferFolderService");

async function main() {
  await mongoose.connect(env.mongoUri);
  // Indices unicos ANTES de aceptar cargas o consumir: en una base nueva se construyen en segundo plano y N cargas
  // simultaneas podrian crear varias carpetas del mismo ciudadano (cuota por carpeta, RNF-04) o duplicar envios.
  await Promise.all([Folder.init(), Document.init(), RevertedTransfer.init(), PackageGrant.init(), OfficialRequest.init()]);

  const secrets = new SecretsManager({ active: env.jwtSecret, previous: env.jwtSecretPrevious });
  logger.info("jwt.llavero", secrets.status()); // solo ids de llave, nunca el secreto

  // ADR-07 / HU-10: llavero aparte para VERIFICAR los tokens institucionales que firma ms-comparticion. Sin llave
  // configurada el servicio arranca igual y la ruta de recepcion responde 401 (el middleware falla cerrado).
  const entitySecrets = env.entityJwtSecret ? new SecretsManager({ active: env.entityJwtSecret, previous: env.entityJwtSecretPrevious }) : null;
  if (entitySecrets) logger.info("jwt.llavero_entidades", entitySecrets.status());
  else logger.warn("ENTITY_JWT_SECRET no esta configurado: POST /api/v1/documents/inbound (HU-10) respondera 401.");

  const storage = ObjectStorageAdapter.fromConfig(env.s3);
  // En local el bucket se crea solo; en despliegue lo provisiona la infraestructura.
  if (env.isLocal) await storage.ensureBucket().catch((err) => logger.warn("storage.bucket_no_verificado", { err }));

  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const documentRepository = new DocumentRepository();
  const folderRepository = new FolderRepository();
  // RNF-04: carpetas anteriores a la cuota por documento se migran ANTES de aceptar cargas.
  const quotaReconciler = new QuotaReconciler({ folderRepository, documentRepository });
  await quotaReconciler.migrateLegacy();
  const eventPublisher = new EventPublisher(env.rabbitUri);
  const documentService = new DocumentService({
    documentRepository,
    folderRepository,
    storage,
    eventPublisher,
    auditLogger,
    quota: env.limits.quotaNoCertificados,
    maxUploadBytes: env.limits.maxUploadBytes,
    downloadTtlSeconds: env.presignedDownloadTtlSeconds,
    eventPublishTimeoutMs: env.eventPublishTimeoutMs,
  });

  // HU-01, paso 7: crear la carpeta al registrarse un ciudadano. Reconecta solo; si el broker no esta al arrancar, el
  // servicio igual sirve (la carpeta tambien se crea en la primera carga).
  const citizenConsumer = new BrokerConsumer({
    uri: env.rabbitUri,
    queue: "ms-documentos.ciudadano-registrado",
    routingKey: "ciudadano.registrado",
    handler: makeCitizenRegisteredHandler({
      folderRepository,
      identityDocumentService: new IdentityDocumentService({ documentRepository, documentService, registraduria: new SimulatedRegistraduriaDocumentClient() }),
    }),
  });
  citizenConsumer.start().catch((err) => {
    logger.error("consumidor.inicio_fallido", { queue: citizenConsumer.queue, err });
    citizenConsumer._scheduleReconnect();
  });

  // Reenvio de los documento.cargado que no se pudieron publicar al cargar.
  if (env.reconcile.intervalMs > 0) {
    new EventReconciler({ documentRepository, eventPublisher, minAgeMs: env.reconcile.minAgeMs, publishTimeoutMs: env.eventPublishTimeoutMs }).start(env.reconcile.intervalMs);
  }

  // HU-06.4: solicitud del documento oficial (la atiende una entrega de HU-10).
  const officialRequestService = new OfficialRequestService({ documentRepository, folderRepository, storage, eventPublisher, auditLogger, eventPublishTimeoutMs: env.eventPublishTimeoutMs });
  const inboundDocumentService = new InboundDocumentService({
    officialRequestService,
    documentService,
    documentRepository,
    folderRepository,
    maxInboundBytes: env.limits.maxInboundBytes,
  });
  // HU-07.1: agregaciones de metadatos para la institucion del token (nunca RabbitMQ/proyeccion en este MVP).
  const documentAnalyticsService = new DocumentAnalyticsService({ documentRepository });
  // HU-06.3: nucleo institucional (PASO 1), decision ciudadana (PASO 2) y publicacion de `solicitud.creada`
  // (PASO 3.2) -- mismo eventPublisher compartido que ya usa documentService, mismo criterio de timeout.
  const solicitudRepository = new SolicitudRepository();
  const solicitudService = new SolicitudService({ solicitudRepository, folderRepository, eventPublisher, eventPublishTimeoutMs: env.eventPublishTimeoutMs });

  // Reenvio de los solicitud.creada que no se pudieron publicar al crear (mismo criterio/config que el de documento.cargado).
  if (env.reconcile.intervalMs > 0) {
    new SolicitudEventReconciler({ solicitudRepository, eventPublisher, minAgeMs: env.reconcile.minAgeMs, publishTimeoutMs: env.eventPublishTimeoutMs }).start(env.reconcile.intervalMs);
  }

  // HU-04: solicitud de autenticacion (el resultado llega por evento desde ms-autenticacion).
  const documentAuthenticationService = new DocumentAuthenticationService({
    documentRepository,
    folderRepository,
    eventPublisher,
    auditLogger,
    eventPublishTimeoutMs: env.eventPublishTimeoutMs,
  });
  // HU-04: el resultado llega de ms-autenticacion (que predeclara estas colas). Reconectan solos, como el de arriba.
  const authResult = makeAuthenticationResultHandlers({ documentAuthenticationService });
  for (const consumer of [
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-documentos.documento-autenticado", routingKey: "documento.autenticado", handler: authResult.autenticado }),
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-documentos.documento-autenticacion-fallida", routingKey: "documento.autenticacion_fallida", handler: authResult.autenticacionFallida }),
  ]) {
    consumer.start().catch((err) => {
      logger.error("consumidor.inicio_fallido", { queue: consumer.queue, err });
      consumer._scheduleReconnect();
    });
  }
  // HU-05c (origen): bloquear/exportar, borrar al confirmarse y desbloquear si falla. Las colas las predeclara
  // ms-interoperabilidad. Las URLs que se exportan duran lo mismo que una descarga del ciudadano (tope 1 h, ADR-06).
  const transferHandlers = makeTransferHandlers({
    transferFolderService: new TransferFolderService({ folderRepository, documentRepository, storage, eventPublisher, urlTtlSeconds: env.presignedDownloadTtlSeconds, maxDocuments: env.transfer.maxDocuments, eventPublishTimeoutMs: env.eventPublishTimeoutMs }),
  });
  // HU-06.2: entrega de paquetes documentales (URLs del correo: 1 h, como la descarga propia; de la entidad: 15 min).
  const packageDeliveryService = new PackageDeliveryService({
    documentRepository,
    folderRepository,
    storage,
    eventPublisher,
    auditLogger,
    emailUrlTtlSeconds: env.presignedDownloadTtlSeconds,
    entityUrlTtlSeconds: 900,
    eventPublishTimeoutMs: env.eventPublishTimeoutMs,
  });
  const importHandlers = makeTransferImportHandlers({
    transferImportService: new TransferImportService({
      documentRepository,
      folderRepository,
      storage,
      fetcher: new RemoteFileFetcher({ timeoutMs: env.transferImport.timeoutMs, maxBytes: env.transferImport.maxBytes, allowPrivate: env.transferImport.allowPrivateUrls }),
      eventPublisher,
      eventPublishTimeoutMs: env.eventPublishTimeoutMs,
    }),
    maxDocuments: env.transfer.maxDocuments,
  });
  for (const consumer of [
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-documentos.transferencia-exportar", routingKey: "transferencia.exportar_carpeta", handler: transferHandlers.exportar }),
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-documentos.ciudadano-transferido", routingKey: "ciudadano.transferido", handler: transferHandlers.transferido }),
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-documentos.transferencia-cancelada", routingKey: "transferencia.cancelada", handler: transferHandlers.cancelada }),
    // HU-05c (destino): importar los documentos de un ciudadano que llega. prefetch 1: cada orden descarga archivos.
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-documentos.transferencia-importar", routingKey: "transferencia.importar_documentos", handler: importHandlers.importar, prefetch: 1 }),
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-documentos.transferencia-revertir", routingKey: "transferencia.revertir_importacion", handler: importHandlers.revertir }),
    // HU-06.2: la cola la predeclara ms-comparticion.
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-documentos.paquete-creado", routingKey: "paquete.creado", handler: makePackageCreatedHandler({ packageDeliveryService }) }),
    // HU-06.4: la cola la predeclara ms-comparticion.
    new BrokerConsumer({ uri: env.rabbitUri, queue: "ms-documentos.solicitud-oficial-resuelta", routingKey: "solicitud_oficial.resuelta", handler: makeOfficialRequestResolvedHandler({ officialRequestService }) }),
  ]) {
    consumer.start().catch((err) => {
      logger.error("consumidor.inicio_fallido", { queue: consumer.queue, err });
      consumer._scheduleReconnect();
    });
  }
  if (env.reconcile.intervalMs > 0) {
    new OfficialRequestReconciler({ officialRequestService, minAgeMs: env.reconcile.minAgeMs }).start(env.reconcile.intervalMs);
    new AuthenticationRequestReconciler({ documentRepository, folderRepository, authenticationService: documentAuthenticationService, minAgeMs: env.reconcile.minAgeMs, timeoutMs: env.authenticationTimeoutMs }).start(env.reconcile.intervalMs);
    quotaReconciler.start(env.reconcile.intervalMs);
  }

  const app = buildApp({
    documentService,
    inboundDocumentService,
    documentAnalyticsService,
    solicitudService,
    documentAuthenticationService,
    packageDeliveryService,
    officialRequestService,
    secrets,
    entitySecrets,
    issuer: env.jwtIssuer,
    entityIssuer: env.entityJwtIssuer,
    auditLogger,
    maxUploadBytes: env.limits.maxUploadBytes,
    maxInboundBytes: env.limits.maxInboundBytes,
  });
  const server = createServer(app, env.tls);
  server.listen(env.port, () => {
    const transport = env.tls.certPath ? (env.tls.caPath ? "mTLS" : "TLS") : "http";
    logger.info("ms-documentos escuchando", { port: env.port, transport });
  });
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-documentos", { err });
  process.exit(1);
});
