const express = require("express");
const requireEntityAuth = require("../security/requireEntityAuth");

const BODY_LIMIT = "32kb"; // un caso PQRS son unos pocos KB (subject + description): un cuerpo grande es un abuso

/**
 * Rutas de casos PQRS (HU-07.2). Todas exigen un token INSTITUCIONAL valido (ADR-07); la institucion dueña de
 * cada caso sale de `req.auth.institutionId` (el `sub` del token), nunca de la peticion.
 *   POST   /cases            crear un caso
 *   GET    /cases            listar los casos de la institucion autenticada (paginado)
 *   GET    /cases/:id        consultar un caso propio (404 si no existe o es de otra institucion)
 *   PATCH  /cases/:id/status cambiar el estado de un caso propio
 */
function pqrsRoutes({ controller, entitySecrets, entityIssuer }) {
  const router = express.Router();
  const auth = requireEntityAuth(entitySecrets, entityIssuer ? { issuer: entityIssuer } : undefined);
  const jsonOnly = (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ error: "el cuerpo debe ser application/json" }));
  const body = express.json({ limit: BODY_LIMIT });

  router.post("/cases", auth, jsonOnly, body, controller.create);
  router.get("/cases", auth, controller.list);
  router.get("/cases/:id", auth, controller.get);
  router.patch("/cases/:id/status", auth, jsonOnly, body, controller.updateStatus);

  return router;
}

module.exports = pqrsRoutes;
