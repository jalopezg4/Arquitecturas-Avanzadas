const logger = require("../tracing/logger");
const { ValidationError, DocumentRequestNotFoundError } = require("../application/DocumentRequestService");

function makeDocumentRequestController(documentRequestService) {
  return {
    async create(req, res, next) {
      try {
        const body = req.body || {};
        const result = await documentRequestService.create({
          institutionId: req.auth.institutionId,
          direccionUnica: body.direccionUnica,
          descripcion: body.descripcion,
          operadorDestinoId: body.operadorDestinoId,
        });
        return res.status(201).json(result);
      } catch (err) {
        return next(err);
      }
    },

    async list(req, res, next) {
      try {
        const result = await documentRequestService.list({ institutionId: req.auth.institutionId, page: req.query.page, pageSize: req.query.pageSize });
        return res.status(200).json(result);
      } catch (err) {
        return next(err);
      }
    },

    async get(req, res, next) {
      try {
        const result = await documentRequestService.get({ institutionId: req.auth.institutionId, requestId: req.params.id });
        return res.status(200).json(result);
      } catch (err) {
        return next(err);
      }
    },
  };
}

/** Traduce errores conocidos a respuestas HTTP; lo inesperado es un 500 generico (sin detalles internos). */
function errorHandler(err, _req, res, _next) {
  if (err instanceof ValidationError) return res.status(400).json({ error: "datos invalidos", detalles: err.problems });
  if (err instanceof DocumentRequestNotFoundError) return res.status(404).json({ error: err.message });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "el cuerpo es demasiado grande" });
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) return res.status(400).json({ error: "el cuerpo no es un JSON valido" });
  logger.error("document_requests.error_inesperado", { err });
  return res.status(500).json({ error: "Error interno" });
}

module.exports = { makeDocumentRequestController, errorHandler };
