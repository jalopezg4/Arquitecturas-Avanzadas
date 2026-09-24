const logger = require("../tracing/logger");
const { ValidationError, UnsupportedMediaTypeError, PayloadTooLargeError, QuotaExceededError, StorageUnavailableError } = require("../application/DocumentService");
const { DestinatarioNoEncontradoError, EnvioConflictError } = require("../application/InboundDocumentService");

/**
 * El dueno de la carpeta es quien lleva el token: /citizens/:id/documents solo acepta que :id sea el sub del
 * token. Se comprueba ANTES de leer el archivo, y un intento sobre una carpeta ajena queda en la bitacora (RNF-07).
 */
function requireOwner(auditLogger, action = "documento.cargar") {
  return async function owner(req, res, next) {
    if (req.auth.ciudadanoId === req.params.id) return next();
    try {
      await auditLogger.record({
        actor: req.auth.ciudadanoId,
        actorType: "ciudadano",
        action,
        resource: `carpeta:${req.params.id}`,
        resourceOwner: req.params.id,
        outcome: "rechazo",
        reason: "no_es_dueno",
      });
    } catch (err) {
      logger.error("audit.write_failed", { action, err });
    }
    return res.status(403).json({ error: "solo el dueno de la carpeta puede acceder a sus documentos" });
  };
}

function makeDocumentController(documentService, inboundDocumentService) {
  return {
    async list(req, res, next) {
      try {
        return res.status(200).json(await documentService.list({ ciudadanoId: req.params.id, page: req.query.page, pageSize: req.query.pageSize }));
      } catch (err) {
        return next(err);
      }
    },
    async upload(req, res, next) {
      try {
        const body = req.body || {};
        const result = await documentService.upload({
          ciudadanoId: req.params.id,
          file: req.file,
          metadata: { titulo: body.titulo, entidadAvaladora: body.entidadAvaladora, fecha: body.fecha, solicitudId: body.solicitudId },
        });
        return res.status(201).json(result);
      } catch (err) {
        return next(err);
      }
    },

    /**
     * HU-10: una entidad emisora entrega un documento en la carpeta de un ciudadano.
     *
     * Quien es la entidad sale de `req.auth` (token institucional ya validado por requireEntityAuth +
     * requireVerifiedEntity), NUNCA del cuerpo. A quien va dirigido sale de la direccion unica del cuerpo, nunca de
     * un ciudadanoId: si llegara uno, se ignora.
     *
     * `201` la primera vez; `200` si es un reintento del mismo envio (idempotencia), para que el cliente distinga
     * sin tener que comparar nada.
     */
    async receive(req, res, next) {
      try {
        const body = req.body || {};
        const result = await inboundDocumentService.receive({
          destinatario: body.destinatario,
          envioId: body.envioId,
          emisor: { id: req.auth.institutionId, verificada: req.auth.verificada },
          file: req.file,
          metadata: { titulo: body.titulo, entidadAvaladora: body.entidadAvaladora, fecha: body.fecha },
        });
        return res.status(result.duplicado ? 200 : 201).json({ documentoId: result.documentoId, duplicado: result.duplicado });
      } catch (err) {
        return next(err);
      }
    },
  };
}

/** Traduce errores conocidos a respuestas HTTP; lo inesperado es un 500 generico (sin detalles internos). */
function errorHandler(err, _req, res, _next) {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof UnsupportedMediaTypeError) return res.status(415).json({ error: err.message });
  if (err instanceof PayloadTooLargeError) return res.status(413).json({ error: err.message });
  if (err instanceof QuotaExceededError) return res.status(409).json({ error: err.message, limite: err.limit });
  // HU-10: la direccion unica no corresponde a nadie de este operador. 404 con el mismo mensaje que una direccion
  // mal formada: no se confirma ni se niega quien esta afiliado aqui.
  if (err instanceof DestinatarioNoEncontradoError) return res.status(404).json({ error: err.message });
  // HU-10: ese envioId ya se uso para otro envio. No se devuelve el documento anterior en silencio.
  if (err instanceof EnvioConflictError) return res.status(409).json({ error: err.message, documentoId: err.documentoId });
  if (err instanceof StorageUnavailableError) return res.status(503).json({ error: err.message });
  logger.error("documentos.error_inesperado", { err });
  return res.status(500).json({ error: "Error interno" });
}

module.exports = { makeDocumentController, requireOwner, errorHandler };
