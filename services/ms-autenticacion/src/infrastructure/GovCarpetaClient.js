const axios = require("axios");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

/**
 * Adapter de GovCarpeta para HU-04: PUT /apis/authenticateDocument (contrato verificado, docs/GOVCARPETA_CONTRATO.md).
 *
 *   cuerpo:     { idCitizen: number, UrlDocument: string, documentTitle: string }   -- `UrlDocument` con U MAYUSCULA
 *   respuestas: 200 texto plano ("El documento: ... ha sido autenticado exitosamente"), 204, 500, 501
 *
 * Se le envia la URL prefirmada, NUNCA el archivo (RNF-13, RNF-14). Es un PUT sobre el mismo documento: repetirlo no
 * crea nada nuevo, asi que reintentar ante 500 o falla de red es seguro.
 *
 * Clasificacion del resultado:
 *   - 200                    -> autenticado (unica confirmacion explicita: "solo pasa a certificado con 200")
 *   - 500 / sin respuesta    -> transitorio: se reintenta con espera creciente, hasta `maxAttempts` (3)
 *   - 204, 501, 4xx, otros   -> DEFINITIVO (`definitive: true`): reintentar no cambia la respuesta
 *   - reintentos agotados    -> error `GOVCARPETA_UNAVAILABLE`
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
      if (res && res.status !== 500) {
        throw Object.assign(new Error(`authenticateDocument respondio ${res.status}`), { response: { status: res.status }, definitive: true, intentos: attempt });
      }
      if (res) lastError = Object.assign(new Error("authenticateDocument respondio 500"), { response: { status: 500 } });
      if (attempt < this.maxAttempts) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
    }
    const err = new Error(`GovCarpeta no respondio tras ${this.maxAttempts} intentos`);
    err.code = "GOVCARPETA_UNAVAILABLE";
    err.intentos = this.maxAttempts;
    err.cause = lastError;
    throw err;
  }
}

module.exports = GovCarpetaClient;
