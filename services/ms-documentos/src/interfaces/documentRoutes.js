const express = require("express");
const requireAuth = require("../security/requireAuth");
const requireEntityAuth = require("../security/requireEntityAuth");
const requireVerifiedEntity = require("../security/requireVerifiedEntity");
const uploadMiddleware = require("./uploadMiddleware");
const { requireOwner } = require("./documentController");

/**
 * Rutas del ciudadano (HU-03, HU-08)
 * POST/GET /citizens/:id/documents
 * Orden: 1) token valido (revalidado AQUI, no solo en el gateway, ADR-06) -> 2) el token es del dueno de :id
 * -> 3) recien entonces se lee el archivo -> 4) controlador. Quien no debe no hace que el servicio bufferice nada.
 *
 * Ruta de la entidad emisora (HU-10)
 * POST /documents/inbound
 * Mismo principio, con la cadena institucional (ADR-07): 1) token INSTITUCIONAL valido (401) -> 2) la entidad esta
 * verificada por el operador (403) -> 3) recien entonces se lee el archivo -> 4) controlador. No lleva `:id` en la
 * ruta a proposito: el destinatario se nombra por su direccion unica y se resuelve dentro del servicio, asi que no
 * hay ningun `ciudadanoId` que el cliente pueda elegir.
 *
 * Analitica de metadatos para la institucion emisora (HU-07.1)
 * GET /documents/analytics/summary
 * Mismo token INSTITUCIONAL (ADR-07) que /documents/inbound, pero SIN requireVerifiedEntity: por ahora esta ruta
 * solo exige identidad institucional, no verificacion (y mucho menos un plan Premium -- ver docs/SEGURIDAD.md,
 * seccion 12.2, esa misma decision ya se documento para ms-analitica/HU-07.2). Aunque cuelga de `/api/v1` como
 * cualquier otra ruta, es interna de servicio: no esta en la lista blanca del gateway (routes.js) todavia, asi
 * que solo es alcanzable directamente contra este servicio, igual que ya pasaba con /documents/inbound antes de
 * HU-10 y sigue pasando con /api/v1/cases en ms-analitica.
 *
 * Solicitud documental intra-operador (HU-06.3)
 * PASO 1 -- institucional: POST/GET /document-requests, GET /document-requests/:id
 * Mismo par de middlewares que /documents/inbound (ADR-07): token INSTITUCIONAL (401) + entidad verificada por el
 * operador (403) -- crear o consultar solicitudes sobre un ciudadano es tan sensible como entregarle un
 * documento. Path DISTINTO del de ms-analitica (`/api/v1/premium/document-requests`, HU-07.3): son dos agregados
 * y dos servicios diferentes, ver docs/SEGURIDAD.md seccion 12.3.
 *
 * PASO 2 -- ciudadano: GET /citizens/me/document-requests, PATCH /citizens/me/document-requests/:id/decision
 * Mismo `requireAuth` (token de CIUDADANO) que /citizens/:id/documents. `me`, no `:id`, a proposito: la identidad
 * es SIEMPRE `req.auth.ciudadanoId`, no hay ningun parametro de ruta con el que confundirla ni que revalidar.
 * `decision` es el unico campo que se lee del cuerpo; el servicio hace la transicion de estado de forma atomica
 * (ver SolicitudRepository.decide) y responde 409 si la solicitud ya tenia una decision.
 *
 * `express.json()`: primera vez que este servicio recibe cuerpo JSON (las demas rutas son multipart), por eso los
 * errores de parseo se traducen en el errorHandler de documentController.js.
 */
function documentRoutes({ controller, secrets, entitySecrets, issuer, entityIssuer, auditLogger, maxUploadBytes, maxInboundBytes }) {
  const router = express.Router();
  router.get("/citizens/:id/documents", requireAuth(secrets, { issuer }), requireOwner(auditLogger, "documento.consultar"), controller.list);
  router.post("/citizens/:id/documents", requireAuth(secrets, { issuer }), requireOwner(auditLogger, "documento.cargar"), uploadMiddleware({ maxUploadBytes }), controller.upload);

  router.post(
    "/documents/inbound",
    requireEntityAuth(entitySecrets, entityIssuer ? { issuer: entityIssuer } : undefined),
    requireVerifiedEntity(auditLogger, "documento.recibir"),
    uploadMiddleware({ maxUploadBytes: maxInboundBytes }),
    controller.receive
  );

  router.get("/documents/analytics/summary", requireEntityAuth(entitySecrets, entityIssuer ? { issuer: entityIssuer } : undefined), controller.analyticsSummary);

  const authEntity = requireEntityAuth(entitySecrets, entityIssuer ? { issuer: entityIssuer } : undefined);
  const jsonBody = express.json({ limit: "16kb" }); // una solicitud son unos pocos KB: un cuerpo grande es un abuso
  router.post("/document-requests", authEntity, requireVerifiedEntity(auditLogger, "solicitud.crear"), jsonBody, controller.createSolicitud);
  router.get("/document-requests", authEntity, requireVerifiedEntity(auditLogger, "solicitud.listar"), controller.listSolicitudes);
  router.get("/document-requests/:id", authEntity, requireVerifiedEntity(auditLogger, "solicitud.consultar"), controller.getSolicitud);

  const authCitizen = requireAuth(secrets, { issuer });
  router.get("/citizens/me/document-requests", authCitizen, controller.listMyDocumentRequests);
  router.patch("/citizens/me/document-requests/:id/decision", authCitizen, jsonBody, controller.decideDocumentRequest);

  return router;
}

module.exports = documentRoutes;
