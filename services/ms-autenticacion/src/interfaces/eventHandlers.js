const { PermanentError } = require("../infrastructure/BrokerConsumer");
const { PresignedUrlService } = require("../application/PresignedUrlService");

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TITULO = 300;

function need(cond, message) {
  if (!cond) throw new PermanentError(message);
}

/**
 * Valida `documento.autenticacion_solicitada` (lo publica ms-documentos) y lo normaliza. Un mensaje que no cumple
 * nunca se va a poder procesar: `PermanentError` -> cola de fallidos, sin reintentar y sin llamar a GovCarpeta.
 */
function parseSolicitud(payload) {
  need(payload && typeof payload === "object" && !Array.isArray(payload), "el mensaje no es un objeto");
  const { eventId, documentoId, ciudadanoId, documento, titulo, storageKey, intento } = payload;
  need(typeof eventId === "string" && ID_RE.test(eventId), "eventId invalido");
  need(typeof documentoId === "string" && ID_RE.test(documentoId), "documentoId invalido");
  need(typeof ciudadanoId === "string" && ID_RE.test(ciudadanoId), "ciudadanoId invalido");
  need(Number.isSafeInteger(documento) && documento > 0, "documento (cedula) invalido");
  need(typeof titulo === "string" && titulo.trim() && titulo.length <= MAX_TITULO, "titulo invalido");
  need(Number.isSafeInteger(intento) && intento > 0, "intento invalido");
  need(PresignedUrlService.isValidKey(storageKey, ciudadanoId), "storageKey invalida o de otro ciudadano");
  return { eventId, documentoId, ciudadanoId, documento, titulo: titulo.trim(), storageKey, intento };
}

/**
 * `documento.autenticacion_solicitada` (HU-04). Si GovCarpeta no respondio tras los 3 intentos, el resultado
 * (`documento.autenticacion_fallida`) ya se publico, y ademas el mensaje original va a la cola de fallidos para que
 * quede la evidencia de la falla del centralizador (criterio de la HU). Un rechazo definitivo (p. ej. 501) es un
 * resultado procesado: se confirma normalmente.
 */
function makeEventHandlers({ authenticationService }) {
  return {
    async autenticacionSolicitada(payload) {
      const solicitud = parseSolicitud(payload);
      const result = await authenticationService.process(solicitud);
      if (result.motivo === "no_disponible") throw new PermanentError("GovCarpeta no respondio tras agotar los reintentos");
    },
  };
}

module.exports = { makeEventHandlers, parseSolicitud };
