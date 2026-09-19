const axios = require("axios");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

const MAX_OPERATORS = 5000; // el directorio real tiene ~70; una respuesta enorme es un error o un ataque de memoria
const MAX_NAME = 200;
const MAX_PARTICIPANTS = 20;
const MAX_URL = 2048;

/** Quita caracteres de control (sin escribirlos en una regex: se filtran por codigo). */
const printable = (s) => [...String(s)].filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join("");

/**
 * El Swagger dice que getOperators devuelve `OperatorId`/`OperatorName` (O mayuscula), pero el sandbox REAL devuelve
 * `_id` y `operatorName` (verificado el 2026-09-19 sobre 71 operadores), y `transferAPIURL` viene con un espacio
 * inicial y solo en algunos. En registerCitizen/unregisterCitizen, en cambio, se ENVIAN como `operatorId`/`operatorName`.
 * Se aceptan todas las formas: si el parseo fuera sensible a mayusculas, un typo romperia la localizacion sin avisar.
 */
function normalizeOperator(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw._id ?? raw.OperatorId ?? raw.operatorId ?? raw.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const operatorId = String(id).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(operatorId)) return null;

  const name = printable(raw.operatorName ?? raw.OperatorName ?? raw.name ?? "").trim().slice(0, MAX_NAME);
  if (!name) return null; // sin nombre no se puede localizar por nombre ni mostrar

  const transfer = raw.transferAPIURL ?? raw.transferApiUrl ?? raw.TransferAPIURL;
  const url = typeof transfer === "string" ? transfer.trim() : "";
  const participants = Array.isArray(raw.participants) ? raw.participants.filter((p) => typeof p === "string").slice(0, MAX_PARTICIPANTS).map((p) => printable(p).trim().slice(0, MAX_NAME)).filter(Boolean) : [];
  return { id: operatorId, name, transferApiUrl: url && url.length <= MAX_URL ? url : null, participants };
}

/**
 * Cliente de SOLO LECTURA del directorio de operadores de GovCarpeta. Reintenta fallas de red y 500 (es idempotente);
 * no reintenta 4xx ni una respuesta con forma inesperada (reintentar no la arregla).
 */
class GovCarpetaDirectoryClient {
  constructor({ baseUrl, http, maxRetries = 3, baseDelayMs = 200, timeoutMs = 10000 }) {
    this.baseUrl = baseUrl;
    this.http = http || axios.create({ timeout: timeoutMs, maxContentLength: 5 * 1024 * 1024, maxBodyLength: 1024 * 1024 });
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
  }

  _traceHeaders() {
    const traceId = getTraceId();
    return traceId ? { [TRACE_ID_HEADER]: traceId } : {};
  }

  async _withRetry(fn) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err.nonRetryable) throw err;
        lastError = err;
        const status = err.response && err.response.status;
        if (!(status === undefined || status === 500)) throw err; // 4xx / 501: definitivo
        if (attempt < this.maxRetries) await new Promise((r) => setTimeout(r, this.baseDelayMs * 2 ** (attempt - 1)));
      }
    }
    const err = new Error("GovCarpeta no respondio tras agotar reintentos");
    err.code = "GOVCARPETA_UNAVAILABLE";
    err.cause = lastError;
    throw err;
  }

  /** GET /apis/getOperators -> lista normalizada [{id, name, transferApiUrl|null, participants}] sin duplicados por id. */
  async listOperators() {
    return this._withRetry(async () => {
      const res = await this.http.get(`${this.baseUrl}/apis/getOperators`, { headers: this._traceHeaders() });
      if (!Array.isArray(res.data)) throw Object.assign(new Error("getOperators no devolvio una lista"), { nonRetryable: true });
      if (res.data.length > MAX_OPERATORS) throw Object.assign(new Error(`getOperators devolvio demasiados operadores (${res.data.length})`), { nonRetryable: true });
      const seen = new Set();
      const operators = [];
      for (const raw of res.data) {
        const op = normalizeOperator(raw);
        if (!op || seen.has(op.id)) continue;
        seen.add(op.id);
        operators.push(op);
      }
      return operators;
    });
  }
}

module.exports = { GovCarpetaDirectoryClient, normalizeOperator };
