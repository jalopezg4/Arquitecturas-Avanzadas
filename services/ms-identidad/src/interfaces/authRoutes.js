const express = require("express");
const requireAuth = require("../security/requireAuth");

function authRoutes(authController, secrets) {
  const router = express.Router();
  router.post("/auth/login", authController.login);
  router.post("/auth/refresh", authController.refresh);
  router.get("/auth/me", requireAuth(secrets), authController.me);
  // ADR-06: autenticacion escalonada (confirmar la contrasena antes de una operacion sensible).
  router.post("/auth/reauthenticate", requireAuth(secrets), authController.reauthenticate);
  // Ciudadano transferido (HU-05c): fija su contrasena con el codigo de un solo uso que recibio por correo.
  router.post("/auth/activate", authController.activate);
  router.post("/auth/activate/resend", authController.resendActivation);
  return router;
}

module.exports = authRoutes;
