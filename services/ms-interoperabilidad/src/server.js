const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const Operator = require("./domain/Operator");
const DirectoryState = require("./domain/DirectoryState");
const { OperatorRepository } = require("./infrastructure/OperatorRepository");
const { GovCarpetaDirectoryClient } = require("./infrastructure/GovCarpetaDirectoryClient");
const { OperatorDirectoryService } = require("./application/OperatorDirectoryService");

async function main() {
  await mongoose.connect(env.mongoUri);
  // Los indices unicos deben existir ANTES de escribir el directorio (un refresco no puede duplicar operadores).
  await Promise.all([Operator.init(), DirectoryState.init()]);

  if (!env.operatorId) {
    logger.warn("OPERATOR_ID no esta configurado -- no se podra impedir una transferencia hacia este mismo operador. Ver docs/OPERADOR_MINTIC.md.");
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

  const app = buildApp({ isReady: () => mongoose.connection.readyState === 1 });
  app.listen(env.port, () => logger.info("ms-interoperabilidad escuchando", { port: env.port }));
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-interoperabilidad", { err });
  process.exit(1);
});
