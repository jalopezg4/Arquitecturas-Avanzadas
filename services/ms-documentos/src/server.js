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

async function main() {
  await mongoose.connect(env.mongoUri);

  const secrets = new SecretsManager({ active: env.jwtSecret, previous: env.jwtSecretPrevious });
  logger.info("jwt.llavero", secrets.status()); // solo ids de llave, nunca el secreto

  const storage = ObjectStorageAdapter.fromConfig(env.s3);
  // En local el bucket se crea solo; en despliegue lo provisiona la infraestructura.
  if (env.isLocal) await storage.ensureBucket().catch((err) => logger.warn("storage.bucket_no_verificado", { err }));

  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const documentService = new DocumentService({
    documentRepository: new DocumentRepository(),
    folderRepository: new FolderRepository(),
    storage,
    eventPublisher: new EventPublisher(env.rabbitUri),
    auditLogger,
    quota: env.limits.quotaNoCertificados,
    maxUploadBytes: env.limits.maxUploadBytes,
    downloadTtlSeconds: env.presignedDownloadTtlSeconds,
    eventPublishTimeoutMs: env.eventPublishTimeoutMs,
  });

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
