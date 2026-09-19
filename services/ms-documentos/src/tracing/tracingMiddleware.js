const { newTraceId, isValidTraceId, runWithTrace, TRACE_ID_HEADER } = require("./TraceContext");
const logger = require("./logger");

const QUIET_PATHS = new Set(["/health", "/ready"]);

/**
 * Cada peticion recibe un trace-id: se reutiliza el que llega en `x-trace-id` (si viene de otro
 * servicio o del gateway y tiene formato valido) o se genera uno nuevo. Queda disponible en todo
 * el codigo de la peticion y se devuelve en la respuesta para poder reportarlo.
 */
function tracingMiddleware(req, res, next) {
  const incoming = req.get(TRACE_ID_HEADER);
  const traceId = isValidTraceId(incoming) ? incoming : newTraceId();
  res.setHeader(TRACE_ID_HEADER, traceId);
  // Se guarda en la peticion para poder RESTAURAR el contexto tras middlewares que lo pierden (p. ej. multer, que
  // procesa el cuerpo con eventos de stream ajenos al contexto asincrono del request).
  req.traceId = traceId;

  runWithTrace(traceId, () => {
    const quiet = QUIET_PATHS.has(req.path);
    if (!quiet) logger.info("request.start", { method: req.method, path: req.path });
    // El evento 'finish' no siempre conserva el contexto asincrono: se pasa el traceId explicito.
    res.on("finish", () => {
      if (!quiet) logger.info("request.end", { traceId, status: res.statusCode });
    });
    next();
  });
}

module.exports = tracingMiddleware;
