const dns = require("dns");
const http = require("http");
const https = require("https");
const { assertSafeTransferUrl, UnsafeTransferUrlError, isPrivateAddress } = require("../security/transferUrl");

class RemoteFileError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.name = "RemoteFileError";
    this.transient = transient;
  }
}

/**
 * HU-05c (destino): descarga un documento desde la URL que envio el operador ORIGEN. Las URLs son de un tercero no
 * confiable, asi que:
 *   - el texto de la URL pasa la politica de HU-05a (http/https, sin credenciales, sin hosts o IPs locales);
 *   - la IP RESUELTA se valida al conectar, en el mismo paso (DNS rebinding);
 *   - no se siguen redirecciones (un 302 hacia la red interna saltaria todo lo anterior);
 *   - plazo y tamano maximos: se corta en cuanto se supera `maxBytes` (nunca se bufferiza de mas).
 * Devuelve `{buffer, contentType}`. Un 5xx o una falla de red es transitoria (`transient: true`); lo demas no.
 */
class RemoteFileFetcher {
  constructor({ timeoutMs = 30000, maxBytes = 50 * 1024 * 1024, allowPrivate = false } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.allowPrivate = allowPrivate;
  }

  _lookup() {
    const allowPrivate = this.allowPrivate;
    return (hostname, options, callback) => {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) return callback(new UnsafeTransferUrlError(`${hostname} resuelve a una direccion local o privada`));
        if (options && options.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
      });
    };
  }

  fetch(rawUrl) {
    let url;
    try {
      url = new URL(assertSafeTransferUrl(rawUrl, { allowPrivate: this.allowPrivate }));
    } catch (err) {
      return Promise.reject(new RemoteFileError(err.message));
    }
    const client = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.get(url, { lookup: this._lookup(), timeout: this.timeoutMs }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new RemoteFileError(`el origen respondio ${res.statusCode}`, { transient: res.statusCode >= 500 }));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > this.maxBytes) {
          res.destroy();
          return reject(new RemoteFileError(`el documento supera ${this.maxBytes} bytes`));
        }
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > this.maxBytes) {
            res.destroy();
            reject(new RemoteFileError(`el documento supera ${this.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: String(res.headers["content-type"] || "") }));
        res.on("error", (err) => reject(new RemoteFileError(`descarga interrumpida: ${err.message}`, { transient: true })));
      });
      req.on("timeout", () => req.destroy(new RemoteFileError("el origen no respondio a tiempo", { transient: true })));
      req.on("error", (err) => {
        if (err instanceof RemoteFileError) return reject(err);
        if (err instanceof UnsafeTransferUrlError) return reject(new RemoteFileError(err.message));
        return reject(new RemoteFileError(`no se pudo descargar: ${err.code || err.message}`, { transient: true }));
      });
    });
  }
}

module.exports = { RemoteFileFetcher, RemoteFileError };
