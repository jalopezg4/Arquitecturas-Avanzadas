const express = require("express");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const documentRoutes = require("./interfaces/documentRoutes");
const { makeDocumentController, errorHandler } = require("./interfaces/documentController");

/**
 * Ensambla la app inyectando dependencias -- facil de probar con supertest.
 *
 * `inboundDocumentService` y `entitySecrets` son de HU-10 (recepcion desde una entidad emisora). Sin ellos el
 * servicio sigue atendiendo al ciudadano igual: la ruta institucional responde 401 (el middleware falla cerrado).
 */
function buildApp({ documentService, inboundDocumentService, secrets, entitySecrets, issuer, entityIssuer, auditLogger, maxUploadBytes, maxInboundBytes }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => res.status(200).json({ status: "ready" }));

  // Sin express.json(): la unica ruta recibe multipart (multer) y nada aqui debe parsear cuerpos sin limite.
  app.use(
    "/api/v1",
    documentRoutes({
      controller: makeDocumentController(documentService, inboundDocumentService),
      secrets,
      entitySecrets,
      issuer,
      entityIssuer,
      auditLogger,
      maxUploadBytes,
      maxInboundBytes: maxInboundBytes || maxUploadBytes,
    })
  );

  app.use(errorHandler);
  return app;
}

module.exports = buildApp;
