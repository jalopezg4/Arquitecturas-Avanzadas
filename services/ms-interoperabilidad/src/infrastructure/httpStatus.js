/**
 * Clasificacion comun de una respuesta HTTP de un sistema externo (GovCarpeta u otro operador). Copiada a proposito
 * en cada servicio que la usa (no hay paquete compartido); si cambia aqui, cambiarla en todas las copias.
 *
 *   transitorio  sin respuesta (red, DNS, timeout), 408, 425, 429 y 5xx salvo 501: reintentar puede funcionar
 *                (un dyno de Heroku dormido responde 503; un gateway delante, 502/504/429)
 *   definitivo   501 (no implementado / ya existe en GovCarpeta), 3xx (no se siguen redirecciones) y el resto de 4xx
 */
const TRANSITORIOS_4XX = new Set([408, 425, 429]);

function isTransientStatus(status) {
  if (status === undefined || status === null) return true;
  if (TRANSITORIOS_4XX.has(status)) return true;
  return status >= 500 && status !== 501;
}

/**
 * `Retry-After` en milisegundos (segundos o fecha HTTP), o null si no viene o no se entiende. Quien lo usa lo acota:
 * un tercero no puede dictar una espera arbitraria.
 */
function parseRetryAfter(value, now = new Date()) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (/^\d{1,10}$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}

/** Acota una espera sugerida al rango [min, max]; sin sugerencia, `min`. */
function boundedDelay(suggestedMs, minMs, maxMs) {
  if (typeof suggestedMs !== "number" || !Number.isFinite(suggestedMs)) return minMs;
  return Math.min(maxMs, Math.max(minMs, suggestedMs));
}

module.exports = { isTransientStatus, parseRetryAfter, boundedDelay };
