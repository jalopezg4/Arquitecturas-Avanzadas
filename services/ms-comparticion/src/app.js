const express = require("express");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const { institutionRoutes, errorHandler } = require("./interfaces/institutionRoutes");

/** Ensambla la app inyectando dependencias -- facil de probar con supertest. */
function buildApp({ institutionService, registrationToken = "", isReady = () => true }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => (isReady() ? res.status(200).json({ status: "ready" }) : res.status(503).json({ status: "not-ready" })));

  app.use("/api/v1", institutionRoutes({ institutionService, registrationToken }));
  app.use(errorHandler);
  return app;
}

module.exports = buildApp;
