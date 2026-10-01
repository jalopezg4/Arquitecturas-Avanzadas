const axios = require("axios");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");
const { isTransientStatus, parseRetryAfter } = require("./httpStatus");

// Lo maximo que se espera por un Retry-After entre intentos: el consumidor no debe quedar bloqueado mucho tiempo.
const MAX_RETRY_AFTER_MS = 5000;

/**
 * Adapter de GovCarpeta para HU-04: PUT /apis/authenticateDocument (contrato verificado, docs/GOVCARPETA_CONTRATO.md).
 *
 *   cuerpo:     { idCitizen: number, UrlDocument: string, documentTitle: string }   -- `UrlDocument` con U MAYUSCULA
 *   respuestas: 200 texto plano ("El documento: ... ha sido autenticado exitosamente"), 204, 500, 501
 *
 * Se le envia la URL prefirmada, NUNCA el archivo (RNF-13, RNF-14). Es un PUT sobre el mismo documento: repetirlo no
 * crea nada nuevo, asi que reintentar ante 500 o falla de red es seguro.
 *
 * Clasificacion del resultado (httpStatus.js, la misma en todos los clientes de GovCarpeta):
 *   - 200                                        -> autenticado (unica confirmacion explicita)
 *   - sin respuesta, 408, 425, 429, 5xx salvo 501 -> transitorio: se reintenta con espera creciente (o el Retry-After,
 *                                                   hasta 5 s), hasta `maxAttempts` (3). El sandbox vive en Heroku: un
 *                                                   dyno dormido responde 503 y el router 502/504/429
 *   - 204, 501, 3xx, otros 4xx                   -> DEFINITIVO (`definitive: true`): reintentar no cambia la respuesta
 *   - reintentos agotados                        -> error `GOVCARPETA_UNAVAILABLE` (el documento vuelve a temporal
 *                                                   con motivo `no_disponible`, no `rechazado`)
 */
class GovCarpetaClient {
  constructor({ baseUrl, http, maxAttempts = 3, baseDelayMs = 1000, timeoutMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.baseUrl = baseUrl;
    this.http = http || axios.create({ timeout: timeoutMs });
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.sleep = sleep;
  }

  _traceHeaders() {
    const traceId = getTraceId();
    return traceId ? { [TRACE_ID_HEADER]: traceId } : {};
  }

  /** @returns {Promise<{status: number, mensaje: string, intentos: number}>} */
  async authenticateDocument({ idCitizen, urlDocument, documentTitle }) {
    const body = { idCitizen: Number(idCitizen), UrlDocument: urlDocument, documentTitle };
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res = null;
      try {
        res = await this.http.put(`${this.baseUrl}/apis/authenticateDocument`, body, {
          validateStatus: () => true,
          // La respuesta de exito es texto plano, no JSON: se conserva tal cual.
          responseType: "text",
          transformResponse: [(data) => data],
          headers: this._traceHeaders(),
        });
      } catch (err) {
        lastError = err; // sin respuesta (red, DNS intermitente del sandbox, timeout): transitorio
      }
      if (res && res.status === 200) return { status: 200, mensaje: typeof res.data === "string" ? res.data : "", intentos: attempt };
      if (res && !isTransientStatus(res.status)) {
        throw Object.assign(new Error(`authenticateDocument respondio ${res.status}`), { response: { status: res.status }, definitive: true, intentos: attempt });
      }
      if (res) lastError = Object.assign(new Error(`authenticateDocument respondio ${res.status}`), { response: { status: res.status } });
      if (attempt < this.maxAttempts) {
        const backoff = this.baseDelayMs * 2 ** (attempt - 1);
        const retryAfter = res ? parseRetryAfter(res.headers && res.headers["retry-after"]) : null;
        await this.sleep(retryAfter === null ? backoff : Math.max(backoff, Math.min(retryAfter, MAX_RETRY_AFTER_MS)));
      }
    }
    const err = new Error(`GovCarpeta no respondio tras ${this.maxAttempts} intentos`);
    err.code = "GOVCARPETA_UNAVAILABLE";
    err.intentos = this.maxAttempts;
    err.cause = lastError;
    throw err;
  }
}

module.exports = GovCarpetaClient;
