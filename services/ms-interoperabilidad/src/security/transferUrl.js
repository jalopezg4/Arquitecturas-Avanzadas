/**
 * La direccion de transferencia la PUBLICA OTRO operador (no confiable) y despues le enviaremos datos de un ciudadano.
 * Sin validarla, un operador malicioso (o con un typo) podria apuntarla a algo interno de nuestra red (SSRF):
 * localhost, la red privada, el servicio de metadatos de la nube (169.254.169.254), o usar credenciales en la URL.
 *
 * Nota: valida el TEXTO de la URL. No resuelve DNS: un nombre publico que resuelva a una IP privada (DNS rebinding)
 * no se detecta aqui; quien haga la llamada real (HU-05c) debe verificar la IP resuelta. Ver docs/SEGURIDAD.md.
 */

class UnsafeTransferUrlError extends Error {
  constructor(reason) {
    super(`direccion de transferencia no permitida: ${reason}`);
    this.name = "UnsafeTransferUrlError";
    this.reason = reason;
  }
}

const MAX_URL_LENGTH = 2048;

function ipv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? m.slice(1).map(Number) : null;
}

function isPrivateIpv4([a, b]) {
  return (
    a === 0 || // "esta red" / 0.0.0.0
    a === 10 || // red privada
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local y metadatos de la nube
    (a === 172 && b >= 16 && b <= 31) || // red privada
    (a === 192 && b === 168) || // red privada
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast y reservado
  );
}

function isPrivateIpv6(host) {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true; // no especificada / loopback
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(h); // IPv4 mapeada
  if (mapped) {
    if (mapped[1]) return isPrivateIpv4(mapped[1].split(".").map(Number));
    const hi = parseInt(mapped[2], 16);
    const lo = parseInt(mapped[3], 16);
    return isPrivateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return false;
}

/**
 * Devuelve la URL normalizada (sin espacios sobrantes) o lanza UnsafeTransferUrlError.
 * @param {string} raw
 * @param {{allowPrivate?: boolean, requireHttps?: boolean}} [options]
 */
function assertSafeTransferUrl(raw, { allowPrivate = false, requireHttps = false } = {}) {
  if (typeof raw !== "string") throw new UnsafeTransferUrlError("no es un texto");
  const text = raw.trim();
  if (!text) throw new UnsafeTransferUrlError("esta vacia");
  if (text.length > MAX_URL_LENGTH) throw new UnsafeTransferUrlError("es demasiado larga");
  if (/[\u0000-\u001f\u007f\s]/.test(text)) throw new UnsafeTransferUrlError("contiene espacios o caracteres de control");

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new UnsafeTransferUrlError("no es una URL valida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeTransferUrlError(`esquema ${url.protocol.replace(":", "")} no permitido (solo http/https)`);
  if (requireHttps && url.protocol !== "https:") throw new UnsafeTransferUrlError("se exige https");
  if (url.username || url.password) throw new UnsafeTransferUrlError("no puede llevar credenciales en la URL");
  if (!url.hostname) throw new UnsafeTransferUrlError("no tiene host");

  if (!allowPrivate) {
    // El parser WHATWG ya normaliza formas ofuscadas de IPv4 (2130706433, 0x7f.1, 0177.0.0.1 -> 127.0.0.1).
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const v6 = host.startsWith("[") ? host.slice(1, -1) : null;
    if (v6 !== null) {
      if (isPrivateIpv6(v6)) throw new UnsafeTransferUrlError("apunta a una direccion IPv6 local o privada");
    } else {
      const v4 = ipv4Parts(host);
      if (v4) {
        if (v4.some((n) => n > 255) || isPrivateIpv4(v4)) throw new UnsafeTransferUrlError("apunta a una direccion IPv4 local o privada");
      } else if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || !host.includes(".")) {
        throw new UnsafeTransferUrlError("apunta a un nombre de host local o interno");
      }
    }
  }
  return url.href;
}

module.exports = { assertSafeTransferUrl, UnsafeTransferUrlError };
