const axios = require("axios");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

/**
 * Adapter de GovCarpeta para la afiliacion del ciudadano durante una transferencia (HU-05c). Mismo contrato que usa
 * ms-identidad en HU-01 (docs/GOVCARPETA_CONTRATO.md), siempre con NUESTRO operador:
 *
 *   DELETE /apis/unregisterCitizen {id, operatorId, operatorName}   -> origen, antes de enviar (el destino no podria
 *                                                                      registrarlo: registerCitizen responde 501 si ya existe)
 *   POST   /apis/registerCitizen   {id, name, address, email, operatorId, operatorName}
 *                                                                   -> compensacion del origen (re-afiliar si fallo)
 *
 * `unregisterCitizen` se reintenta ante 500/red (repetirlo deja el mismo resultado). `registerCitizen` NO se reintenta:
 * si la respuesta se pierde, un reintento recibiria 501 aunque haya funcionado (igual que en ms-identidad).
 */
class GovCarpetaCitizenClient {
  constructor({ baseUrl, operatorId, operatorName, http, maxRetries = 3, baseDelayMs = 200, timeoutMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.baseUrl = baseUrl;
    this.operatorId = operatorId;
    this.operatorName = operatorName;
    this.http = http || axios.create({ timeout: timeoutMs });
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.sleep = sleep;
  }

  _headers() {
    const traceId = getTraceId();
    return traceId ? { [TRACE_ID_HEADER]: traceId } : {};
  }

  _assertOperator() {
    if (!this.operatorId) throw Object.assign(new Error("OPERATOR_ID no esta configurado (ver docs/OPERADOR_MINTIC.md)"), { definitive: true });
  }

  async unregisterCitizen(id) {
    this._assertOperator();
    const body = { id: Number(id), operatorId: this.operatorId, operatorName: this.operatorName };
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let res = null;
      try {
        res = await this.http.delete(`${this.baseUrl}/apis/unregisterCitizen`, { data: body, validateStatus: () => true, headers: this._headers() });
      } catch (err) {
        lastError = err;
      }
      // 201 "Deleted" / 200; 204 "Not Content" = no estaba afiliado a nosotros: para quien se va, el resultado es el mismo.
      if (res && [200, 201, 204].includes(res.status)) return { status: res.status };
      if (res && res.status !== 500) {
        throw Object.assign(new Error(`unregisterCitizen respondio ${res.status}`), { definitive: true, response: { status: res.status } });
      }
      if (res) lastError = Object.assign(new Error("unregisterCitizen respondio 500"), { response: { status: 500 } });
      if (attempt < this.maxRetries) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
    }
    throw Object.assign(new Error("GovCarpeta no respondio tras agotar reintentos"), { code: "GOVCARPETA_UNAVAILABLE", cause: lastError });
  }

  async registerCitizen({ id, name, address, email }) {
    this._assertOperator();
    const body = { id: Number(id), name, address, email, operatorId: this.operatorId, operatorName: this.operatorName };
    let res;
    try {
      res = await this.http.post(`${this.baseUrl}/apis/registerCitizen`, body, { validateStatus: () => true, headers: this._headers() });
    } catch (err) {
      throw Object.assign(new Error("GovCarpeta no respondio a registerCitizen"), { code: "GOVCARPETA_UNAVAILABLE", cause: err });
    }
    if (res.status === 201 || res.status === 200) return { status: res.status };
    throw Object.assign(new Error(`registerCitizen respondio ${res.status}`), { definitive: res.status !== 500, response: { status: res.status } });
  }
}

module.exports = GovCarpetaCitizenClient;
