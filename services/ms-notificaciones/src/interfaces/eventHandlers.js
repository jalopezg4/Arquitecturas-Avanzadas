const { PermanentError } = require("../infrastructure/EventConsumer");

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function need(condition, message) {
  if (!condition) throw new PermanentError(message);
}
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/**
 * Manejadores de los eventos que consume ms-notificaciones. Validan el formato (un mensaje mal formado es un
 * PermanentError: no se reintenta, va a la cola de fallidos) y delegan en el servicio, que es idempotente.
 */
function makeEventHandlers({ notificationService }) {
  return {
    async ciudadanoRegistrado(payload) {
      need(payload && typeof payload === "object", "payload invalido");
      need(typeof payload.ciudadanoId === "string" && ID_RE.test(payload.ciudadanoId), "ciudadanoId invalido");
      need(text(payload.nombre, 200), "nombre invalido o ausente (evento anterior al enriquecimiento)");
      need(typeof payload.correo === "string" && payload.correo.length <= 200 && EMAIL_RE.test(payload.correo), "correo invalido o ausente (evento anterior al enriquecimiento)");
      await notificationService.onCitizenRegistered(payload);
    },

    async documentoCargado(payload) {
      need(payload && typeof payload === "object", "payload invalido");
      need(typeof payload.eventId === "string" && ID_RE.test(payload.eventId), "eventId invalido (sin el no hay idempotencia)");
      need(typeof payload.ciudadanoId === "string" && ID_RE.test(payload.ciudadanoId), "ciudadanoId invalido");
      need(text(payload.titulo, 300), "titulo invalido");
      need(text(payload.entidadAvaladora, 300), "entidadAvaladora invalida");
      await notificationService.onDocumentUploaded(payload);
    },
  };
}

module.exports = makeEventHandlers;
