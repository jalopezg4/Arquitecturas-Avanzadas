const { PermanentError } = require("../infrastructure/BrokerConsumer");

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function need(cond, message) {
  if (!cond) throw new PermanentError(message);
}
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/**
 * Eventos que consume ms-identidad (HU-05c; hasta ahora solo publicaba). Un mensaje mal formado nunca se va a poder
 * procesar: PermanentError -> cola de fallidos, sin reintentar.
 */
function makeTransferHandlers({ citizenTransferService }) {
  return {
    /** `ciudadano.transferido` (origen): el destino confirmo; se revocan sesiones y se borra al ciudadano. */
    async ciudadanoTransferido(payload) {
      need(payload && typeof payload === "object", "payload invalido");
      need(typeof payload.transferenciaId === "string" && ID_RE.test(payload.transferenciaId), "transferenciaId invalido");
      need(typeof payload.ciudadanoId === "string" && OBJECT_ID_RE.test(payload.ciudadanoId), "ciudadanoId invalido");
      await citizenTransferService.onTransferred({ transferenciaId: payload.transferenciaId, ciudadanoId: payload.ciudadanoId });
    },

    /** `transferencia.registrar_ciudadano` (destino): crear y afiliar al ciudadano que llega. */
    async registrarCiudadano(payload) {
      need(payload && typeof payload === "object", "payload invalido");
      need(typeof payload.transferenciaId === "string" && ID_RE.test(payload.transferenciaId), "transferenciaId invalido");
      need(typeof payload.ciudadanoId === "string" && OBJECT_ID_RE.test(payload.ciudadanoId), "ciudadanoId invalido");
      need(Number.isSafeInteger(payload.documento) && payload.documento > 0, "documento invalido");
      need(text(payload.nombre, 200), "nombre invalido");
      need(typeof payload.correo === "string" && payload.correo.length <= 200 && EMAIL_RE.test(payload.correo), "correo invalido");
      await citizenTransferService.importCitizen({
        transferenciaId: payload.transferenciaId,
        ciudadanoId: payload.ciudadanoId,
        documento: payload.documento,
        nombre: payload.nombre.trim(),
        correo: payload.correo.trim(),
        direccion: text(payload.direccion, 300) ? payload.direccion.trim() : null,
        direccionUnica: typeof payload.direccionUnica === "string" && payload.direccionUnica.length <= 200 ? payload.direccionUnica : null,
      });
    },
  };
}

module.exports = { makeTransferHandlers };
