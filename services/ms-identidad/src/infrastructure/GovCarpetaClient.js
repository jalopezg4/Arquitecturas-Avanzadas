const axios = require("axios");

/**
 * Cliente HTTP hacia GovCarpeta. Nombres de campo verificados contra el Swagger real
 * (ver docs/GOVCARPETA_CONTRATO.md en la raiz del repo) -- no son suposiciones.
 */
class GovCarpetaClient {
  constructor({ baseUrl, operatorId, operatorName, maxRetries = 3, http = axios }) {
    this.baseUrl = baseUrl;
    this.operatorId = operatorId;
    this.operatorName = operatorName;
    this.maxRetries = maxRetries;
    this.http = http;
  }

  async _withRetry(fn) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const status = err.response && err.response.status;
        if (status && status < 500) throw err; // errores de negocio no se reintentan
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

  /**
   * GET /apis/validateCitizen/{id}
   * NOTA: el Swagger no documenta el significado exacto de 200 vs 204 (sin schema de
   * respuesta). Verificar empiricamente contra el sandbox antes de confiar en esta
   * interpretacion. Aqui se asume: 200 = disponible para registrar, 204 = ya afiliado.
   */
  async validateCitizen(documento) {
    return this._withRetry(async () => {
      const res = await this.http.get(`${this.baseUrl}/apis/validateCitizen/${documento}`, {
        validateStatus: (s) => s === 200 || s === 204,
      });
      return { available: res.status === 200 };
    });
  }

  /** POST /apis/registerCitizen */
  async registerCitizen({ id, name, address, email }) {
    return this._withRetry(async () => {
      await this.http.post(`${this.baseUrl}/apis/registerCitizen`, {
        id,
        name,
        address,
        email,
        operatorId: this.operatorId,
        operatorName: this.operatorName,
      });
    });
  }

  /** DELETE /apis/unregisterCitizen -- compensacion de la saga */
  async unregisterCitizen(id) {
    return this._withRetry(async () => {
      await this.http.delete(`${this.baseUrl}/apis/unregisterCitizen`, {
        data: { id, operatorId: this.operatorId, operatorName: this.operatorName },
      });
    });
  }
}

module.exports = GovCarpetaClient;
