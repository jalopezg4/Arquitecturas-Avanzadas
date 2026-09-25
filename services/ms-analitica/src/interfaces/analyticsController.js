const logger = require("../tracing/logger");
const { ValidationError } = require("../application/AnalyticsService");
const { UpstreamValidationError, UpstreamUnavailableError } = require("../infrastructure/DocumentsAnalyticsClient");

/** Sin logica HTTP hacia ms-documentos aqui: eso vive en DocumentsAnalyticsClient (infrastructure). */
function makeAnalyticsController(analyticsService) {
  return {
    async summary(req, res, next) {
      try {
        const result = await analyticsService.summarize({
          authorization: req.headers.authorization,
          from: req.query.from,
          to: req.query.to,
        });
        return res.status(200).json(result);
      } catch (err) {
        return next(err);
      }
    },
  };
}

/**
 * Traduce errores conocidos a respuestas HTTP; lo inesperado es un 500 generico (sin detalles internos).
 * Mismo patron que `pqrsController.errorHandler`: no se reutiliza el de otro servicio (formatos distintos).
 */
function errorHandler(err, _req, res, _next) {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  // ms-documentos rechazo from/to (mismo mensaje que el suyo: es la validacion de negocio real, ver AnalyticsService).
  if (err instanceof UpstreamValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof UpstreamUnavailableError) return res.status(503).json({ error: err.message });
  logger.error("analitica.error_inesperado", { err });
  return res.status(500).json({ error: "Error interno" });
}

module.exports = { makeAnalyticsController, errorHandler };
