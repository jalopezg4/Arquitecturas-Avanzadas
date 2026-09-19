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
const EventReconciler = require("./application/EventReconciler");
const { BrokerConsumer } = require("./infrastructure/BrokerConsumer");
const { makeCitizenRegisteredHandler } = require("./interfaces/eventHandlers");

async function main() {
  await mongoose.connect(env.mongoUri);

  const secrets = new SecretsManager({ active: env.jwtSecret, previous: env.jwtSecretPrevious });
  logger.info("jwt.llavero", secrets.status()); // solo ids de llave, nunca el secreto

  const storage = ObjectStorageAdapter.fromConfig(env.s3);
  // En local el bucket se crea solo; en despliegue lo provisiona la infraestructura.
  if (env.isLocal) await storage.ensureBucket().catch((err) => logger.warn("storage.bucket_no_verificado", { err }));

  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const documentRepository = new DocumentRepository();
  const folderRepository = new FolderRepository();
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
    handler: makeCitizenRegisteredHandler({ folderRepository }),
  });
  citizenConsumer.start().catch((err) => {
    logger.error("consumidor.inicio_fallido", { queue: citizenConsumer.queue, err });
    citizenConsumer._scheduleReconnect();
  });

  // Reenvio de los documento.cargado que no se pudieron publicar al cargar.
  if (env.reconcile.intervalMs > 0) {
    new EventReconciler({ documentRepository, eventPublisher, minAgeMs: env.reconcile.minAgeMs, publishTimeoutMs: env.eventPublishTimeoutMs }).start(env.reconcile.intervalMs);
  }

  const app = buildApp({ documentService, secrets, issuer: env.jwtIssuer, auditLogger, maxUploadBytes: env.limits.maxUploadBytes });
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
