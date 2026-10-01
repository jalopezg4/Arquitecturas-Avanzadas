const express = require("express");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const { transferRoutes, transferErrorHandler } = require("./interfaces/transferRoutes");

/**
 * /health (vivo) y /ready (listo: base conectada y consumidores suscritos), como el resto (HT-01). Con `sagaService`
 * (HU-05c) monta ademas las rutas de la transferencia bajo /api.
 */
function buildApp({ isReady = () => true, sagaService, receiverService, secrets, issuer } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => (isReady() ? res.status(200).json({ status: "ready" }) : res.status(503).json({ status: "not-ready" })));

  if (sagaService) {
    app.use("/api", transferRoutes({ sagaService, receiverService, secrets, issuer }));
    app.use(transferErrorHandler);
  }
  return app;
}

module.exports = buildApp;
