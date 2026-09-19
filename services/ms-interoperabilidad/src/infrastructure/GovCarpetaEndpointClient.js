const axios = require("axios");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

/**
 * Cliente que MODIFICA el registro de NUESTRO operador en GovCarpeta: publica sus direcciones de recepcion.
 * Esta separado del cliente del directorio (GovCarpetaDirectoryClient, de solo lectura) a proposito: quien solo
 * necesita consultar no recibe la capacidad de escribir.
 *
 * PUT /apis/registerTransferEndPoint -- cuerpo verificado contra el Swagger real (docs/GOVCARPETA_CONTRATO.md):
 *   { idOperator, endPoint, endPointConfirm }   (no `operatorId` ni `transferEndpoint`: el Gherkin del issue esta desactualizado)
 * Respuestas: 201 "Updated" (se acepta tambien 200), 500, 501.
 *
 * Es una ACTUALIZACION (reemplaza los valores del operador), no un alta: repetirla con los mismos datos deja el mismo
 * resultado, asi que reintentar ante fallas de red/500 es seguro (a diferencia de registerOperator, que crea otro operador).
 */
class GovCarpetaEndpointClient {
  constructor({ baseUrl, http, maxRetries = 3, baseDelayMs = 200, timeoutMs = 10000 }) {
    this.baseUrl = baseUrl;
    this.http = http || axios.create({ timeout: timeoutMs });
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
  }

  _traceHeaders() {
    const traceId = getTraceId();
    return traceId ? { [TRACE_ID_HEADER]: traceId } : {};
  }

  async registerTransferEndPoint({ idOperator, endPoint, endPointConfirm }) {
    const body = { idOperator, endPoint, endPointConfirm };
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let res;
      try {
        res = await this.http.put(`${this.baseUrl}/apis/registerTransferEndPoint`, body, { validateStatus: () => true, headers: this._traceHeaders() });
      } catch (err) {
        lastError = err; // sin respuesta (red, timeout): transitorio
        res = null;
      }
      if (res && (res.status === 200 || res.status === 201)) return { status: res.status };
      if (res && res.status !== 500) {
        // 501 ("Wrong Parameters"), 4xx y otros: definitivos, reintentar no lo arregla
        throw Object.assign(new Error(`registerTransferEndPoint respondio ${res.status}`), { response: { status: res.status }, definitive: true });
      }
      if (res) lastError = Object.assign(new Error("registerTransferEndPoint respondio 500"), { response: { status: 500 } });
      if (attempt < this.maxRetries) await new Promise((r) => setTimeout(r, this.baseDelayMs * 2 ** (attempt - 1)));
    }
    const err = new Error("GovCarpeta no respondio tras agotar reintentos");
    err.code = "GOVCARPETA_UNAVAILABLE";
    err.cause = lastError;
    throw err;
  }
}

module.exports = GovCarpetaEndpointClient;
