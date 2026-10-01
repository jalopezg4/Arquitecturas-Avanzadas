const express = require("express");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const { institutionRoutes, errorHandler } = require("./interfaces/institutionRoutes");
const { entityAuthRoutes, entityAuthErrorHandler } = require("./interfaces/entityAuthRoutes");
const { packageRoutes, packageErrorHandler } = require("./interfaces/packageRoutes");

/**
 * Ensambla la app inyectando dependencias -- facil de probar con supertest.
 *
 * `entityAuthService` es OPCIONAL: sin el, el servicio sigue registrando entidades (HU-06.1) pero no expone la
 * autenticacion institucional (ADR-07), y esa ruta responde 404 como cualquier otra no declarada.
 */
function buildApp({ institutionService, entityAuthService, registrationToken = "", isReady = () => true, packageService, secrets, issuer, entitySecrets, entityIssuer, auditLogger }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => (isReady() ? res.status(200).json({ status: "ready" }) : res.status(503).json({ status: "not-ready" })));

  app.use("/api/v1", institutionRoutes({ institutionService, registrationToken }));
  if (entityAuthService) app.use("/api/v1", entityAuthRoutes({ entityAuthService }));
  // HU-06.2: paquetes documentales (opcional, como la autenticacion institucional).
  if (packageService) app.use("/api/v1", packageRoutes({ packageService, secrets, issuer, entitySecrets, entityIssuer, auditLogger }));

  // Orden deliberado: el traductor de credenciales solo atiende su propio error y deja pasar el resto al general.
  app.use(entityAuthErrorHandler);
  app.use(packageErrorHandler);
  app.use(errorHandler);
  return app;
}

module.exports = buildApp;
