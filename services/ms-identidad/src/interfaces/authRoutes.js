const express = require("express");
const requireAuth = require("../security/requireAuth");

function authRoutes(authController, secrets) {
  const router = express.Router();
  router.post("/auth/login", authController.login);
  router.post("/auth/refresh", authController.refresh);
  router.get("/auth/me", requireAuth(secrets), authController.me);
  return router;
}

module.exports = authRoutes;
