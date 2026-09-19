const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const Institution = require("./domain/Institution");
const AuditEntry = require("./domain/AuditEntry");
const { InstitutionRepository } = require("./infrastructure/InstitutionRepository");
const AuditLogger = require("./infrastructure/AuditLogger");
const AuditRepository = require("./infrastructure/AuditRepository");
const { InstitutionService } = require("./application/InstitutionService");

async function main() {
  await mongoose.connect(env.mongoUri);
  // El indice UNICO del NIT debe existir ANTES de aceptar registros: sin el, dos registros simultaneos del mismo NIT
  // podrian crear dos instituciones.
  await Promise.all([Institution.init(), AuditEntry.init()]);

  if (!env.registrationToken) {
    logger.warn("REGISTRATION_TOKEN no esta configurado: el registro de instituciones es ABIERTO (cualquiera puede registrar una entidad). Ver docs/SEGURIDAD.md, seccion 10.");
  }

  const institutionService = new InstitutionService({
    institutionRepository: new InstitutionRepository(),
    auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
  });

  const app = buildApp({ institutionService, registrationToken: env.registrationToken, isReady: () => mongoose.connection.readyState === 1 });
  app.listen(env.port, () => logger.info("ms-comparticion escuchando", { port: env.port, registroAbierto: !env.registrationToken }));
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-comparticion", { err });
  process.exit(1);
});
