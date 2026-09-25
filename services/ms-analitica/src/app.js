const express = require("express");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const pqrsRoutes = require("./interfaces/pqrsRoutes");
const { makePqrsController, errorHandler: pqrsErrorHandler } = require("./interfaces/pqrsController");
const analyticsRoutes = require("./interfaces/analyticsRoutes");
const { makeAnalyticsController, errorHandler: analyticsErrorHandler } = require("./interfaces/analyticsController");
const documentRequestRoutes = require("./interfaces/documentRequestRoutes");
const { makeDocumentRequestController, errorHandler: documentRequestErrorHandler } = require("./interfaces/documentRequestController");

/**
 * HU-07.2 (casos PQRS), HU-07.1 (analitica) y HU-07.3 (solicitud documental, implementacion PARCIAL: solo
 * registro local, sin protocolo multioperador -- ver DocumentRequestService). Los tres servicios son OPCIONALES
 * (como `entityAuthService` en ms-comparticion): sin ellos el servicio sigue arrancando y sirviendo /health y
 * /ready, y la ruta correspondiente responde 404 como cualquier ruta no declarada -- eso es lo que permite que
 * los tests de pasos anteriores sigan funcionando sin cambios.
 */
function buildApp({ isReady = () => true, pqrsCaseService, analyticsService, documentRequestService, entitySecrets, entityIssuer } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => (isReady() ? res.status(200).json({ status: "ready" }) : res.status(503).json({ status: "not-ready" })));

  if (pqrsCaseService) {
    app.use("/api/v1", pqrsRoutes({ controller: makePqrsController(pqrsCaseService), entitySecrets, entityIssuer }));
    app.use(pqrsErrorHandler);
  }

  if (analyticsService) {
    app.use("/api/v1", analyticsRoutes({ controller: makeAnalyticsController(analyticsService), entitySecrets, entityIssuer }));
    app.use(analyticsErrorHandler);
  }

  if (documentRequestService) {
    app.use("/api/v1", documentRequestRoutes({ controller: makeDocumentRequestController(documentRequestService), entitySecrets, entityIssuer }));
    app.use(documentRequestErrorHandler);
  }

  return app;
}

module.exports = buildApp;
