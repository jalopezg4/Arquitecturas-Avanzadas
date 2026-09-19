const axios = require("axios");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

/**
 * Cliente HTTP hacia GovCarpeta. Nombres de campo verificados contra el Swagger real
 * (ver docs/GOVCARPETA_CONTRATO.md en la raiz del repo) -- no son suposiciones.
 */
class GovCarpetaClient {
  constructor({ baseUrl, operatorId, operatorName, maxRetries = 3, http = axios, availableStatus = 204 }) {
    this.baseUrl = baseUrl;
    this.operatorId = operatorId;
    this.operatorName = operatorName;
    this.maxRetries = maxRetries;
    this.http = http;
    // El Swagger de GovCarpeta no documenta el significado de 200 vs 204 en
    // validateCitizen (sin schema de respuesta) -- ver docs/GOVCARPETA_CONTRATO.md.
    // Verificado empiricamente el 2026-09-17 contra el sandbox real: un documento
    // jamas usado por nadie devuelve 204, asi que 204 = disponible (no puede estar
    // "ya afiliado" un documento que nunca se ha registrado). Sigue configurable
    // (constructor o GOVCARPETA_AVAILABLE_STATUS) por si el comportamiento cambia.
    this.availableStatus = availableStatus;
  }

  /** Reenvia el trace-id a GovCarpeta para poder correlacionar la llamada en ambos lados. */
  _traceHeaders() {
    const traceId = getTraceId();
    return traceId ? { [TRACE_ID_HEADER]: traceId } : {};
  }

  /**
   * Reintenta solo fallas de RED o errores 500 (transitorios segun el propio Swagger:
   * "500: failed Application Error"). NO reintenta 501 ("Wrong Parameters" / ya existe,
   * segun el Swagger es un error de negocio definitivo, no transitorio) ni ningun 4xx.
   */
  async _withRetry(fn) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const status = err.response && err.response.status;
        const isTransient = status === undefined || status === 500;
        if (!isTransient) throw err;
        if (attempt < this.maxRetries) {
          const backoffMs = 200 * 2 ** (attempt - 1);
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }
    const err = new Error("GovCarpeta no respondio tras agotar reintentos");
    err.code = "GOVCARPETA_UNAVAILABLE";
    err.cause = lastError;
    throw err;
  }

  /** GET /apis/validateCitizen/{id} -- ver nota sobre `availableStatus` en el constructor. */
  async validateCitizen(documento) {
    return this._withRetry(async () => {
      const res = await this.http.get(`${this.baseUrl}/apis/validateCitizen/${documento}`, {
        validateStatus: (s) => s === 200 || s === 204,
        headers: this._traceHeaders(),
      });
      return { available: res.status === this.availableStatus };
    });
  }

  /**
   * POST /apis/registerCitizen
   * NO usa `_withRetry`: este endpoint no es idempotente y el Swagger no ofrece una
   * clave de idempotencia. Reintentar automaticamente arriesga que, si GovCarpeta acepto
   * el primer intento pero la respuesta se perdio, un reintento reciba 501 ("ya existe")
   * y la saga interprete como fallo un registro que en realidad ya se completo. Se deja
   * como una sola llamada: si falla, la saga registra el estado como `pendiente` y el
   * caso queda para reconciliacion manual/soporte en vez de arriesgar un reintento ciego.
   */
  async registerCitizen({ id, name, address, email }) {
    const res = await this.http.post(
      `${this.baseUrl}/apis/registerCitizen`,
      { id, name, address, email, operatorId: this.operatorId, operatorName: this.operatorName },
      { validateStatus: () => true, headers: this._traceHeaders() }
    );
    if (res.status !== 201) {
      const err = new Error(`registerCitizen respondio ${res.status}, se esperaba 201`);
      err.response = res;
      throw err;
    }
  }

  /** DELETE /apis/unregisterCitizen -- compensacion de la saga (best-effort, si falla se reintenta). */
  async unregisterCitizen(id) {
    return this._withRetry(async () => {
      await this.http.delete(`${this.baseUrl}/apis/unregisterCitizen`, {
        data: { id, operatorId: this.operatorId, operatorName: this.operatorName },
        headers: this._traceHeaders(),
      });
    });
  }
}

module.exports = GovCarpetaClient;
