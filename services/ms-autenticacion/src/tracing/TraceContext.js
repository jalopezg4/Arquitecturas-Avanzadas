const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");

const storage = new AsyncLocalStorage();

// Un trace-id entrante solo se acepta si tiene un formato seguro: se escribe en logs y se
// reenvia a otros sistemas, asi que un valor arbitrario (saltos de linea, JSON) permitiria
// falsificar lineas de log.
const TRACE_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

function newTraceId() {
  return crypto.randomUUID();
}

function isValidTraceId(value) {
  return typeof value === "string" && TRACE_ID_RE.test(value);
}

/** Ejecuta fn con `traceId` disponible para todo el codigo (incluido lo asincrono) que llame fn. */
function runWithTrace(traceId, fn) {
  return storage.run({ traceId }, fn);
}

function getTraceId() {
  const store = storage.getStore();
  return store ? store.traceId : undefined;
}

module.exports = { newTraceId, isValidTraceId, runWithTrace, getTraceId, TRACE_ID_HEADER: "x-trace-id" };
