const express = require("express");
const tracingMiddleware = require("./tracing/tracingMiddleware");

/**
 * Este servicio no expone API de negocio (solo consume eventos). Publica /health (vivo) y /ready (listo para trabajar:
 * base de datos conectada y consumidores suscritos), como el resto (HT-01).
 */
function buildApp({ isReady = () => true } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => (isReady() ? res.status(200).json({ status: "ready" }) : res.status(503).json({ status: "not-ready" })));

  return app;
}

module.exports = buildApp;
