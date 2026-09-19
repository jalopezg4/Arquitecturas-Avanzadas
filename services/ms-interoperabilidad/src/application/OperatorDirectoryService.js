const logger = require("../tracing/logger");
const { assertSafeTransferUrl } = require("../security/transferUrl");

class DirectoryUnavailableError extends Error {
  constructor(cause) {
    super("el directorio de operadores no esta disponible y no hay una copia local utilizable");
    this.name = "DirectoryUnavailableError";
    this.cause = cause;
  }
}
class OperatorNotFoundError extends Error {
  constructor() {
    super("operador no encontrado en el directorio");
    this.name = "OperatorNotFoundError";
  }
}
/** Varios operadores comparten ese nombre (el directorio es compartido): hay que pedir por id. */
class AmbiguousOperatorError extends Error {
  constructor(ids) {
    super(`hay ${ids.length} operadores con ese nombre; usa operatorId`);
    this.name = "AmbiguousOperatorError";
    this.operatorIds = ids;
  }
}
/** El operador existe pero aun no publico su direccion de transferencia (55 de 71 no la tenian el 2026-09-19). */
class NoTransferEndpointError extends Error {
  constructor() {
    super("el operador no ha publicado una direccion de transferencia");
    this.name = "NoTransferEndpointError";
  }
}
class SelfTransferError extends Error {
  constructor() {
    super("el destino es este mismo operador");
    this.name = "SelfTransferError";
  }
}
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * HU-05a: localizacion de operadores y resolucion de su direccion de transferencia, con COPIA LOCAL del directorio de
 * GovCarpeta (ADR-03) y una politica de refresco explicita para no usar direcciones obsoletas.
 *
 * POLITICA DE REFRESCO
 *   - Vigencia (ttl, 60 min por defecto): pasada, el directorio se refresca ANTES de usarlo.
 *   - Operador no encontrado, o sin direccion publicada: se intenta UN refresco forzado (pudo registrarse o publicar hace
 *     poco; el directorio es compartido y cambia), pero no mas de uno cada `minForcedRefresh` (30 s): pedir operadores
 *     inexistentes en bucle no debe martillar al sandbox compartido.
 *   - GovCarpeta no responde: para BUSCAR se sirve la copia vieja (marcada `stale: true`) hasta `maxStale` (24 h);
 *     para RESOLVER UNA DIRECCION DE TRANSFERENCIA no: se le van a enviar datos de un ciudadano, asi que nunca se
 *     usa una direccion que no se pudo confirmar vigente.
 *   - Un refresco que devuelve la lista VACIA no reemplaza a un directorio bueno (parece una falla, no un directorio vacio).
 *   - Varias consultas simultaneas con la copia vencida comparten UN solo refresco.
 */
class OperatorDirectoryService {
  constructor({ client, repository, ownOperatorId = "", ttlMs, maxStaleMs, minForcedRefreshMs, urlPolicy = {}, now = () => new Date() }) {
    this.client = client;
    this.repository = repository;
    this.ownOperatorId = ownOperatorId;
    this.ttlMs = ttlMs;
    this.maxStaleMs = maxStaleMs;
    this.minForcedRefreshMs = minForcedRefreshMs;
    this.urlPolicy = urlPolicy;
    this.now = now;
    this._inflight = null;
    this._lastAttemptAt = 0;
  }

  /** Refresca el directorio desde GovCarpeta. Las llamadas simultaneas comparten UNA sola peticion. */
  refresh() {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      this._lastAttemptAt = this.now().getTime();
      const operators = await this.client.listOperators();
      if (operators.length === 0 && (await this.repository.getState())) throw new Error("GovCarpeta devolvio un directorio vacio; se conserva la copia local");
      const result = await this.repository.replaceDirectory(operators, this.now());
      logger.info("directorio.refrescado", { operadores: result.count });
      return result;
    })().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  async _ensureFresh({ allowStale }) {
    let state = await this.repository.getState();
    const age = state ? this.now().getTime() - state.refreshedAt.getTime() : Infinity;
    if (state && age <= this.ttlMs) return { state, stale: false };
    try {
      await this.refresh();
      state = await this.repository.getState();
      return { state, stale: false };
    } catch (err) {
      if (allowStale && state && age <= this.maxStaleMs) {
        logger.warn("directorio.copia_vencida", { edadMinutos: Math.round(age / 60000), note: "GovCarpeta no respondio; se usa la copia local" });
        return { state, stale: true };
      }
      logger.error("directorio.no_disponible", { err });
      throw new DirectoryUnavailableError(err);
    }
  }

  /** Refresco forzado, limitado a uno cada minForcedRefreshMs. Devuelve el estado nuevo o null si no se hizo/fallo. */
  async _forceRefresh(state) {
    const since = this.now().getTime() - Math.max(this._lastAttemptAt, state ? state.refreshedAt.getTime() : 0);
    if (since < this.minForcedRefreshMs) return null;
    try {
      await this.refresh();
      return await this.repository.getState();
    } catch (err) {
      logger.warn("directorio.refresco_forzado_fallo", { err });
      return null;
    }
  }

  async _lookup(state, { operatorId, name }) {
    if (operatorId) return this.repository.findById(state.currentGeneration, operatorId);
    const matches = await this.repository.findByName(state.currentGeneration, name);
    if (matches.length > 1) throw new AmbiguousOperatorError(matches.map((m) => m.operatorId));
    return matches[0] || null;
  }

  /**
   * Localiza un operador por `operatorId` o por `name` (sin distinguir mayusculas ni espacios repetidos).
   * @returns {{operator: object, stale: boolean, refreshedAt: Date}}
   */
  async findOperator({ operatorId, name } = {}, { allowStale = true } = {}) {
    const byId = typeof operatorId === "string" && operatorId.trim() !== "";
    const byName = typeof name === "string" && name.trim() !== "";
    if (byId === byName) throw new ValidationError("indica operatorId o name (uno solo)");
    if (byId && !/^[A-Za-z0-9_-]{1,64}$/.test(operatorId.trim())) throw new ValidationError("operatorId invalido");
    if (byName && name.length > 200) throw new ValidationError("name demasiado largo");
    const query = byId ? { operatorId: operatorId.trim() } : { name };

    let { state, stale } = await this._ensureFresh({ allowStale });
    let operator = await this._lookup(state, query);
    if (!operator) {
      const refreshed = await this._forceRefresh(state);
      if (refreshed) {
        state = refreshed;
        stale = false;
        operator = await this._lookup(state, query);
      }
    }
    if (!operator) throw new OperatorNotFoundError();
    return { operator, stale, refreshedAt: state.refreshedAt };
  }

  /**
   * Direccion de transferencia PUBLICADA por el operador destino, ya validada (esquema, sin IPs privadas, sin
   * credenciales). Es ESTRICTA: nunca devuelve una direccion sacada de una copia que no se pudo confirmar vigente.
   * @returns {{operatorId: string, name: string, transferApiUrl: string, refreshedAt: Date}}
   */
  async resolveTransferAddress(operatorId) {
    let { operator, refreshedAt } = await this.findOperator({ operatorId }, { allowStale: false });
    if (operator.operatorId === this.ownOperatorId) throw new SelfTransferError();

    if (!operator.transferApiUrl) {
      // Pudo publicarla hace un momento: un refresco forzado (limitado) antes de rendirse.
      const refreshed = await this._forceRefresh({ refreshedAt });
      if (refreshed) {
        operator = (await this.repository.findById(refreshed.currentGeneration, operator.operatorId)) || operator;
        refreshedAt = refreshed.refreshedAt;
      }
    }
    if (!operator.transferApiUrl) throw new NoTransferEndpointError();

    const transferApiUrl = assertSafeTransferUrl(operator.transferApiUrl, this.urlPolicy);
    return { operatorId: operator.operatorId, name: operator.name, transferApiUrl, refreshedAt };
  }
}

module.exports = { OperatorDirectoryService, DirectoryUnavailableError, OperatorNotFoundError, AmbiguousOperatorError, NoTransferEndpointError, SelfTransferError, ValidationError };
