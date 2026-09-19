const { getTraceId } = require("./TraceContext");

const SERVICE = process.env.SERVICE_NAME || "ms-interoperabilidad";

const stdoutSink = (line) => process.stdout.write(`${line}\n`);
const silentSink = () => {};

let sink = process.env.LOG_SILENT === "1" ? silentSink : stdoutSink;

function serializeError(err) {
  return { name: err.name, message: err.message, code: err.code };
}

/**
 * Log estructurado (una linea JSON). Incluye siempre el trace-id del contexto actual para poder
 * correlacionar lineas de un mismo request, incluso entre servicios. No registrar datos
 * personales aqui (documento, correo, password): el trace-id ya permite correlacionar.
 */
function log(level, msg, fields = {}) {
  const { err, ...rest } = fields;
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    traceId: getTraceId(),
    msg,
    ...rest,
  };
  if (err) entry.err = serializeError(err);
  sink(JSON.stringify(entry));
}

module.exports = {
  info: (msg, fields) => log("info", msg, fields),
  warn: (msg, fields) => log("warn", msg, fields),
  error: (msg, fields) => log("error", msg, fields),
  /** Solo para tests: reemplaza donde se escriben las lineas. */
  setSink: (fn) => {
    sink = fn;
  },
  resetSink: () => {
    sink = process.env.LOG_SILENT === "1" ? silentSink : stdoutSink;
  },
};
