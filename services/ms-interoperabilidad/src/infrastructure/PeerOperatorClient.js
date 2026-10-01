const dns = require("dns");
const nodeHttp = require("http");
const nodeHttps = require("https");
const axios = require("axios");
const { assertSafeTransferUrl, UnsafeTransferUrlError, isPrivateAddress } = require("../security/transferUrl");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");
const { isTransientStatus, parseRetryAfter } = require("./httpStatus");

/**
 * `lookup` para axios que rechaza la conexion si el nombre resuelve a una IP local o privada. Va en el MISMO paso en
 * que se conecta: validar antes con dns.lookup y conectar despues dejaria una ventana para DNS rebinding.
 */
function makeSafeLookup({ allowPrivate, resolve = dns.lookup }) {
  return function safeLookup(hostname, options, callback) {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return callback(new UnsafeTransferUrlError(`${hostname} resuelve a una direccion local o privada`));
      }
      if (options && options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * Cliente HTTP hacia OTROS operadores (HU-05c): `transferCitizen` (origen -> destino) y `transferCitizenConfirm`
 * (destino -> origen). Sus direcciones las publican terceros no confiables, asi que:
 *   - el texto de la URL pasa la politica de HU-05a (esquema, sin credenciales, sin hosts/IPs locales);
 *   - la IP resuelta se valida al conectar (DNS rebinding), SIEMPRE: agentes propios sin keep-alive, asi ninguna llamada
 *     reutiliza un socket abierto antes (con el agente global de Node, un socket reutilizado se salta la resolucion);
 *   - sin redirecciones (un 302 hacia la red interna saltaria todo lo anterior);
 *   - plazo acotado y respuesta acotada (un operador lento o que responde basura no bloquea la saga).
 *
 * Devuelve `{status, data}` para 2xx. Si no, lanza: con `definitive: true` cuando reintentar no lo arregla (URL
 * insegura, 3xx, 4xx, 501) y sin esa marca cuando es transitorio (red, 408, 425, 429, 5xx; ver httpStatus.js). Un
 * transitorio con `Retry-After` lleva `retryAfterMs`, que quien reintenta acota.
 */
class PeerOperatorClient {
  // `resolve` (dns.lookup por defecto) solo se inyecta en pruebas, para demostrar el bloqueo de DNS rebinding sin DNS real.
  constructor({ http, timeoutMs = 15000, allowPrivate = false, requireHttps = false, resolve } = {}) {
    this.urlPolicy = { allowPrivate, requireHttps };
    const lookup = makeSafeLookup({ allowPrivate, resolve });
    this.http =
      http ||
      axios.create({
        timeout: timeoutMs,
        maxRedirects: 0,
        maxContentLength: 64 * 1024,
        lookup,
        httpAgent: new nodeHttp.Agent({ keepAlive: false, lookup }),
        httpsAgent: new nodeHttps.Agent({ keepAlive: false, lookup }),
      });
  }

  async post(url, body) {
    const traceId = getTraceId();
    let res;
    try {
      // Dentro del try: una URL que la politica rechaza es un error DEFINITIVO (reintentar no la vuelve segura).
      const safeUrl = assertSafeTransferUrl(url, this.urlPolicy);
      res = await this.http.post(safeUrl, body, { validateStatus: () => true, headers: { "Content-Type": "application/json", ...(traceId ? { [TRACE_ID_HEADER]: traceId } : {}) } });
    } catch (err) {
      if (err instanceof UnsafeTransferUrlError || (err && err.cause instanceof UnsafeTransferUrlError)) throw Object.assign(new Error(err.message), { definitive: true });
      throw Object.assign(new Error(`el operador no respondio: ${err.code || err.message}`), { cause: err });
    }
    if (res.status >= 200 && res.status < 300) return { status: res.status, data: res.data };
    const transient = isTransientStatus(res.status);
    const retryAfterMs = transient ? parseRetryAfter(res.headers && res.headers["retry-after"]) : null;
    throw Object.assign(new Error(`el operador respondio ${res.status}`), { status: res.status, definitive: !transient, ...(retryAfterMs !== null ? { retryAfterMs } : {}) });
  }
}

module.exports = { PeerOperatorClient, makeSafeLookup };
