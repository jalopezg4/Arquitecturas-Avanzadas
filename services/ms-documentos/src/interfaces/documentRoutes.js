const express = require("express");
const requireAuth = require("../security/requireAuth");
const uploadMiddleware = require("./uploadMiddleware");
const { requireOwner } = require("./documentController");

/**
 * POST /citizens/:id/documents
 * Orden: 1) token valido (revalidado AQUI, no solo en el gateway, ADR-06) -> 2) el token es del dueno de :id
 * -> 3) recien entonces se lee el archivo -> 4) controlador. Quien no debe no hace que el servicio bufferice nada.
 */
function documentRoutes({ controller, secrets, issuer, auditLogger, maxUploadBytes }) {
  const router = express.Router();
  router.post("/citizens/:id/documents", requireAuth(secrets, { issuer }), requireOwner(auditLogger), uploadMiddleware({ maxUploadBytes }), controller.upload);
  return router;
}

module.exports = documentRoutes;
