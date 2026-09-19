const express = require("express");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const documentRoutes = require("./interfaces/documentRoutes");
const { makeDocumentController, errorHandler } = require("./interfaces/documentController");

/** Ensambla la app inyectando dependencias -- facil de probar con supertest. */
function buildApp({ documentService, secrets, issuer, auditLogger, maxUploadBytes }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => res.status(200).json({ status: "ready" }));

  // Sin express.json(): la unica ruta recibe multipart (multer) y nada aqui debe parsear cuerpos sin limite.
  app.use("/api/v1", documentRoutes({ controller: makeDocumentController(documentService), secrets, issuer, auditLogger, maxUploadBytes }));

  app.use(errorHandler);
  return app;
}

module.exports = buildApp;
