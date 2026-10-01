const express = require("express");
const tracingMiddleware = require("./tracing/tracingMiddleware");

/**
 * ms-autenticacion no expone API de negocio: consume `documento.autenticacion_solicitada` y publica el resultado
 * (HU-04). Publica /health (vivo) y /ready (base de datos conectada y consumidor suscrito), como el resto (HT-01).
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
