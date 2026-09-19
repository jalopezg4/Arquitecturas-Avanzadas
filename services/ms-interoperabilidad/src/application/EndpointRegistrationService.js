const logger = require("../tracing/logger");
const { assertSafeTransferUrl, UnsafeTransferUrlError } = require("../security/transferUrl");

const OPERATOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TRANSFER_PATH = "/api/transferCitizen";
const CONFIRM_PATH = "/api/transferCitizenConfirm";

/** Datos de entrada mal formados o inseguros. No se envio nada. */
class EndpointInputError extends Error {
  constructor(problems) {
    super(`No se puede publicar el endpoint:\n - ${problems.join("\n - ")}`);
    this.name = "EndpointInputError";
    this.problems = problems;
  }
}
/** Falta el operatorId (HU-11 sin completar) o no existe en el directorio. No se envio nada. */
class OperatorNotRegisteredError extends Error {
  constructor(message) {
    super(message);
    this.name = "OperatorNotRegisteredError";
  }
}
/** El endpoint ya esta publicado (HU-05b: "falla explicitamente, no lo intenta duplicar"). No se envio nada. */
class AlreadyPublishedError extends Error {
  constructor(message, { current, same }) {
    super(message);
    this.name = "AlreadyPublishedError";
    this.current = current;
    this.same = same;
  }
}
class PublicationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PublicationError";
  }
}

/** Compara dos URLs ya normalizadas (minusculas en el host, barra final...): "http://A.co" y "http://a.co/" son la misma. */
function sameUrl(a, b) {
  try {
    return new URL(String(a).trim()).href === new URL(String(b).trim()).href;
  } catch {
    return false;
  }
}

/** base + ruta, sin barras duplicadas: "https://x.co/" + "/api/t" -> "https://x.co/api/t". */
function join(base, path) {
  return `${String(base).trim().replace(/\/+$/, "")}${path}`;
}

/**
 * HU-05b: publica ante GovCarpeta la direccion donde este operador RECIBE transferencias, para que otros operadores
 * puedan iniciarlas (`PUT /apis/registerTransferEndPoint`). Operacion de infraestructura, no de usuario final.
 *
 * Orden (cada paso falla ANTES de enviar nada):
 *   1. exige el operatorId de HU-11 y que exista en el directorio
 *   2. valida las direcciones (son las que veran otros operadores: no pueden ser localhost ni redes privadas)
 *   3. falla si YA hay una direccion publicada (salvo `replace`, decision explicita de reemplazarla)
 *   4. simulacion (dryRun) o publicacion; luego se VERIFICA leyendo el directorio
 * Si la respuesta se pierde, se relee el directorio antes de dar la publicacion por fallida.
 */
class EndpointRegistrationService {
  constructor({ directoryClient, endpointClient, urlPolicy = {} }) {
    this.directoryClient = directoryClient;
    this.endpointClient = endpointClient;
    this.urlPolicy = urlPolicy;
  }

  /** Resuelve y valida las dos direcciones. Devuelve {endPoint, endPointConfirm}; lanza EndpointInputError con TODOS los problemas. */
  resolveUrls({ baseUrl, endPoint, endPointConfirm }) {
    const problems = [];
    if (!baseUrl && !(endPoint && endPointConfirm)) problems.push("define PUBLIC_BASE_URL (o TRANSFER_ENDPOINT_URL y TRANSFER_CONFIRM_URL)");
    const wanted = { endPoint: endPoint || (baseUrl ? join(baseUrl, TRANSFER_PATH) : ""), endPointConfirm: endPointConfirm || (baseUrl ? join(baseUrl, CONFIRM_PATH) : "") };

    const clean = {};
    for (const [name, url] of Object.entries(wanted)) {
      if (!url) continue;
      try {
        clean[name] = assertSafeTransferUrl(url, this.urlPolicy);
      } catch (err) {
        if (!(err instanceof UnsafeTransferUrlError)) throw err;
        problems.push(`${name}: ${err.reason}`);
      }
    }
    if (clean.endPoint && clean.endPointConfirm && clean.endPoint === clean.endPointConfirm) problems.push("endPoint y endPointConfirm deben ser direcciones distintas (transferCitizen y transferCitizenConfirm)");
    if (problems.length) throw new EndpointInputError(problems);
    return clean;
  }

  async _directory() {
    try {
      return await this.directoryClient.listOperators();
    } catch (err) {
      // Sin poder comprobar si ya esta publicado no se envia nada: seria adivinar.
      throw new PublicationError("No se pudo consultar el directorio de operadores para comprobar el estado actual; no se publico nada. Reintenta mas tarde.", { cause: err });
    }
  }

  /**
   * @param {object} input     operatorId, baseUrl | endPoint + endPointConfirm
   * @param {object} options   dryRun (no envia), replace (permite reemplazar una direccion ya publicada)
   * @returns {{status: "dry-run"|"published"|"recovered", payload: object, verified?: boolean}}
   */
  async publish({ operatorId, baseUrl, endPoint, endPointConfirm } = {}, { dryRun = false, replace = false } = {}) {
    if (!operatorId) throw new OperatorNotRegisteredError("Falta OPERATOR_ID: registra primero el operador (HU-11, npm run register:operator en ms-identidad; ver docs/OPERADOR_MINTIC.md).");
    if (!OPERATOR_ID_RE.test(operatorId)) throw new EndpointInputError(["OPERATOR_ID no tiene un formato valido"]);

    const urls = this.resolveUrls({ baseUrl, endPoint, endPointConfirm });
    const payload = { idOperator: operatorId, endPoint: urls.endPoint, endPointConfirm: urls.endPointConfirm };

    const before = await this._directory();
    const me = before.find((o) => o.id === operatorId);
    if (!me) throw new OperatorNotRegisteredError(`El operatorId ${operatorId} no existe en el directorio de GovCarpeta: completa primero el registro del operador (HU-11). No se publico nada.`);

    if (me.transferApiUrl && !replace) {
      const same = sameUrl(me.transferApiUrl, urls.endPoint);
      throw new AlreadyPublishedError(
        `El operador ya tiene una direccion de transferencia publicada (${me.transferApiUrl})` +
          `${same ? ", que es la misma que se iba a publicar" : ""}. No se publico nada. Si de verdad hay que cambiarla, repite con --replace.`,
        { current: me.transferApiUrl, same }
      );
    }
    if (dryRun) return { status: "dry-run", payload, replacing: Boolean(me.transferApiUrl) };

    try {
      await this.endpointClient.registerTransferEndPoint(payload);
    } catch (err) {
      if (err.definitive) {
        const status = err.response && err.response.status;
        throw new PublicationError(`GovCarpeta rechazo la publicacion (${status}). No se cambio nada.`, { cause: err });
      }
      // Sin respuesta tras los reintentos: pudo haberse aplicado. Se relee el directorio antes de rendirse.
      try {
        const after = (await this.directoryClient.listOperators()).find((o) => o.id === operatorId);
        if (after && sameUrl(after.transferApiUrl, urls.endPoint)) return { status: "recovered", payload, verified: true };
      } catch {
        // si tampoco se puede consultar, se informa abajo
      }
      throw new PublicationError("No se pudo confirmar la publicacion (GovCarpeta no respondio). Revisa el directorio (GET /apis/getOperators) buscando tu operador antes de reintentar.", { cause: err });
    }

    // Verificacion: el directorio deberia reflejar la direccion nueva. Si no (demora del sandbox), se avisa, no se falla.
    let verified = false;
    try {
      const after = (await this.directoryClient.listOperators()).find((o) => o.id === operatorId);
      verified = Boolean(after && sameUrl(after.transferApiUrl, urls.endPoint));
    } catch (err) {
      logger.warn("endpoint.verificacion_no_disponible", { err });
    }
    if (!verified) logger.warn("endpoint.publicado_sin_verificar", { note: "GovCarpeta acepto la publicacion pero el directorio aun no la refleja" });
    return { status: "published", payload, verified };
  }
}

module.exports = { EndpointRegistrationService, EndpointInputError, OperatorNotRegisteredError, AlreadyPublishedError, PublicationError, TRANSFER_PATH, CONFIRM_PATH };
