const express = require("express");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const { institutionRoutes, errorHandler } = require("./interfaces/institutionRoutes");
const { entityAuthRoutes, entityAuthErrorHandler } = require("./interfaces/entityAuthRoutes");

/**
 * Ensambla la app inyectando dependencias -- facil de probar con supertest.
 *
 * `entityAuthService` es OPCIONAL: sin el, el servicio sigue registrando entidades (HU-06.1) pero no expone la
 * autenticacion institucional (ADR-07), y esa ruta responde 404 como cualquier otra no declarada.
 */
function buildApp({ institutionService, entityAuthService, registrationToken = "", isReady = () => true }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => (isReady() ? res.status(200).json({ status: "ready" }) : res.status(503).json({ status: "not-ready" })));

  app.use("/api/v1", institutionRoutes({ institutionService, registrationToken }));
  if (entityAuthService) app.use("/api/v1", entityAuthRoutes({ entityAuthService }));

  // Orden deliberado: el traductor de credenciales solo atiende su propio error y deja pasar el resto al general.
  app.use(entityAuthErrorHandler);
  app.use(errorHandler);
  return app;
}

module.exports = buildApp;
