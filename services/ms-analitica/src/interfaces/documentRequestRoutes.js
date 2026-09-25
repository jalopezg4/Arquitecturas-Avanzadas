const express = require("express");
const requireEntityAuth = require("../security/requireEntityAuth");

const BODY_LIMIT = "16kb"; // una solicitud son unos pocos KB (direccionUnica + descripcion): un cuerpo grande es un abuso

/**
 * Rutas de solicitudes documentales (HU-07.3, implementacion PARCIAL). Todas exigen un token INSTITUCIONAL
 * valido (ADR-07); la institucion dueña de cada solicitud sale de `req.auth.institutionId` (el `sub` del token),
 * nunca de la peticion.
 *   POST /document-requests            registrar una solicitud
 *   GET  /document-requests            listar las solicitudes de la institucion autenticada (paginado)
 *   GET  /document-requests/:id        consultar una solicitud propia (404 si no existe o es de otra institucion)
 */
function documentRequestRoutes({ controller, entitySecrets, entityIssuer }) {
  const router = express.Router();
  const auth = requireEntityAuth(entitySecrets, entityIssuer ? { issuer: entityIssuer } : undefined);
  const jsonOnly = (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ error: "el cuerpo debe ser application/json" }));
  const body = express.json({ limit: BODY_LIMIT });

  router.post("/document-requests", auth, jsonOnly, body, controller.create);
  router.get("/document-requests", auth, controller.list);
  router.get("/document-requests/:id", auth, controller.get);

  return router;
}

module.exports = documentRequestRoutes;
