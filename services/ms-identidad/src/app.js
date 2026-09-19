const express = require("express");
const citizenRoutes = require("./interfaces/citizenRoutes");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const makeCitizenController = require("./interfaces/citizenController");
const authRoutes = require("./interfaces/authRoutes");
const makeAuthController = require("./interfaces/authController");

/** Ensambla la app de Express inyectando dependencias -- facil de testear con supertest. */
function buildApp({ citizenSagaService, authService, secrets }) {
  const app = express();
  app.use(tracingMiddleware);
  app.use(express.json());

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => res.status(200).json({ status: "ready" }));

  const citizenController = makeCitizenController(citizenSagaService);
  app.use("/api/v1", citizenRoutes(citizenController));
  if (authService) app.use("/api/v1", authRoutes(makeAuthController(authService), secrets));

  return app;
}

module.exports = buildApp;
