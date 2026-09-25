const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const PqrsCase = require("./domain/PqrsCase");
const AuditEntry = require("./domain/AuditEntry");
const DocumentRequest = require("./domain/DocumentRequest");
const { PqrsCaseRepository } = require("./infrastructure/PqrsCaseRepository");
const AuditLogger = require("./infrastructure/AuditLogger");
const AuditRepository = require("./infrastructure/AuditRepository");
const SecretsManager = require("./security/SecretsManager");
const { PqrsCaseService } = require("./application/PqrsCaseService");
const { DocumentsAnalyticsClient } = require("./infrastructure/DocumentsAnalyticsClient");
const { AnalyticsService } = require("./application/AnalyticsService");
const { DocumentRequestRepository } = require("./infrastructure/DocumentRequestRepository");
const { DocumentRequestService } = require("./application/DocumentRequestService");

async function main() {
  await mongoose.connect(env.mongoUri);
  await Promise.all([PqrsCase.init(), AuditEntry.init(), DocumentRequest.init()]);

  // Llavero para VERIFICAR los tokens institucionales que firma ms-comparticion (ADR-07). Sin el, /api/v1/cases
  // falla cerrado (401 en toda peticion) en vez de dejar pasar cualquier cosa.
  const entitySecrets = env.entityJwtSecret ? new SecretsManager({ active: env.entityJwtSecret, previous: env.entityJwtSecretPrevious }) : null;
  if (entitySecrets) logger.info("jwt.llavero_entidades", entitySecrets.status());
  else logger.warn("ENTITY_JWT_SECRET no esta configurado: /api/v1/cases (HU-07.2) respondera 401 siempre.");

  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const pqrsCaseService = new PqrsCaseService({ pqrsCaseRepository: new PqrsCaseRepository(), auditLogger });

  // HU-07.1 (PASO 2): cliente REST sincrono hacia el endpoint interno de ms-documentos (Alternativa A aprobada).
  const documentsAnalyticsClient = new DocumentsAnalyticsClient({ baseUrl: env.documentosUrl, timeoutMs: env.documentsAnalyticsTimeoutMs });
  const analyticsService = new AnalyticsService({ documentsAnalyticsClient });

  // HU-07.3, implementacion PARCIAL: solo registro local de la solicitud (ver DocumentRequestService). Ninguna
  // llamada de red hacia ms-interoperabilidad ni hacia ningun otro operador.
  const documentRequestService = new DocumentRequestService({ documentRequestRepository: new DocumentRequestRepository() });

  const app = buildApp({
    isReady: () => mongoose.connection.readyState === 1,
    pqrsCaseService,
    analyticsService,
    documentRequestService,
    entitySecrets,
    entityIssuer: env.entityJwtIssuer,
  });
  app.listen(env.port, () => logger.info("ms-analitica escuchando", { port: env.port }));
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-analitica", { err });
  process.exit(1);
});
