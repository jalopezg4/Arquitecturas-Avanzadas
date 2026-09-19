const logger = require("../tracing/logger");
const { ValidationError, UnsupportedMediaTypeError, PayloadTooLargeError, QuotaExceededError, StorageUnavailableError } = require("../application/DocumentService");

/**
 * El dueno de la carpeta es quien lleva el token: /citizens/:id/documents solo acepta que :id sea el sub del
 * token. Se comprueba ANTES de leer el archivo, y un intento sobre una carpeta ajena queda en la bitacora (RNF-07).
 */
function requireOwner(auditLogger) {
  return async function owner(req, res, next) {
    if (req.auth.ciudadanoId === req.params.id) return next();
    try {
      await auditLogger.record({
        actor: req.auth.ciudadanoId,
        actorType: "ciudadano",
        action: "documento.cargar",
        resource: `carpeta:${req.params.id}`,
        resourceOwner: req.params.id,
        outcome: "rechazo",
        reason: "no_es_dueno",
      });
    } catch (err) {
      logger.error("audit.write_failed", { action: "documento.cargar", err });
    }
    return res.status(403).json({ error: "solo el dueno de la carpeta puede cargar documentos en ella" });
  };
}

function makeDocumentController(documentService) {
  return {
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
  };
}

/** Traduce errores conocidos a respuestas HTTP; lo inesperado es un 500 generico (sin detalles internos). */
function errorHandler(err, _req, res, _next) {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof UnsupportedMediaTypeError) return res.status(415).json({ error: err.message });
  if (err instanceof PayloadTooLargeError) return res.status(413).json({ error: err.message });
  if (err instanceof QuotaExceededError) return res.status(409).json({ error: err.message, limite: err.limit });
  if (err instanceof StorageUnavailableError) return res.status(503).json({ error: err.message });
  logger.error("documentos.error_inesperado", { err });
  return res.status(500).json({ error: "Error interno" });
}

module.exports = { makeDocumentController, requireOwner, errorHandler };
