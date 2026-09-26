const dns = require("dns");
const axios = require("axios");
const { assertSafeTransferUrl, UnsafeTransferUrlError, isPrivateAddress } = require("../security/transferUrl");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

/**
 * `lookup` para axios que rechaza la conexion si el nombre resuelve a una IP local o privada. Va en el MISMO paso en
 * que se conecta: validar antes con dns.lookup y conectar despues dejaria una ventana para DNS rebinding.
 */
function makeSafeLookup({ allowPrivate }) {
  return function safeLookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
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
 *   - la IP resuelta se valida al conectar (DNS rebinding);
 *   - sin redirecciones (un 302 hacia la red interna saltaria todo lo anterior);
 *   - plazo acotado y respuesta acotada (un operador lento o que responde basura no bloquea la saga).
 *
 * Devuelve `{status, data}` para 2xx; lanza con `definitive: true` para 4xx (reintentar no lo arregla) y sin esa marca
 * para 5xx/red (transitorio).
 */
class PeerOperatorClient {
  constructor({ http, timeoutMs = 15000, allowPrivate = false, requireHttps = false } = {}) {
    this.urlPolicy = { allowPrivate, requireHttps };
    this.http = http || axios.create({ timeout: timeoutMs, maxRedirects: 0, maxContentLength: 64 * 1024, lookup: makeSafeLookup({ allowPrivate }) });
  }

  async post(url, body) {
    const safeUrl = assertSafeTransferUrl(url, this.urlPolicy);
    const traceId = getTraceId();
    let res;
    try {
      res = await this.http.post(safeUrl, body, { validateStatus: () => true, headers: { "Content-Type": "application/json", ...(traceId ? { [TRACE_ID_HEADER]: traceId } : {}) } });
    } catch (err) {
      if (err instanceof UnsafeTransferUrlError || (err && err.cause instanceof UnsafeTransferUrlError)) throw Object.assign(new Error(err.message), { definitive: true });
      throw Object.assign(new Error(`el operador no respondio: ${err.code || err.message}`), { cause: err });
    }
    if (res.status >= 200 && res.status < 300) return { status: res.status, data: res.data };
    throw Object.assign(new Error(`el operador respondio ${res.status}`), { status: res.status, definitive: res.status >= 400 && res.status < 500 });
  }
}

module.exports = { PeerOperatorClient, makeSafeLookup };
