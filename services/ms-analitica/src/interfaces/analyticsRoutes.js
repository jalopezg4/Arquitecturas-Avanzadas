const express = require("express");
const requireEntityAuth = require("../security/requireEntityAuth");

/**
 * GET /analytics/summary (HU-07.1). Mismo token INSTITUCIONAL que /cases (ADR-07), sin requireVerifiedEntity --
 * misma decision ya documentada para HU-07.2 (identidad != verificacion != Premium, docs/SEGURIDAD.md, 12.2).
 *
 * `req.auth.institutionId` (que deja requireEntityAuth) no se usa en este flujo: quien decide el alcance
 * institucional es ms-documentos, al volver a verificar el MISMO token que este middleware ya valido aqui. Aun
 * asi este middleware es imprescindible: corta en 401 sin token o con uno invalido/de otro emisor, sin depender
 * de que ms-documentos este arriba para rechazarlo.
 */
function analyticsRoutes({ controller, entitySecrets, entityIssuer }) {
  const router = express.Router();
  router.get("/analytics/summary", requireEntityAuth(entitySecrets, entityIssuer ? { issuer: entityIssuer } : undefined), controller.summary);
  return router;
}

module.exports = analyticsRoutes;
