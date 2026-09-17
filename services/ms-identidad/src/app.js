const express = require("express");
const citizenRoutes = require("./interfaces/citizenRoutes");
const makeCitizenController = require("./interfaces/citizenController");

/** Ensambla la app de Express inyectando dependencias -- facil de testear con supertest. */
function buildApp({ citizenSagaService }) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => res.status(200).json({ status: "ready" }));

  const citizenController = makeCitizenController(citizenSagaService);
  app.use("/api/v1", citizenRoutes(citizenController));

  return app;
}

module.exports = buildApp;
