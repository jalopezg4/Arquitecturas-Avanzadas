const { PermanentError } = require("../infrastructure/EventConsumer");

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SINGLE_EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

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

    // HU-04: resultado de la autenticacion (lo publica ms-autenticacion). eventId por intento y resultado.
    async documentoAutenticado(payload) {
      need(payload && typeof payload === "object", "payload invalido");
      need(typeof payload.eventId === "string" && ID_RE.test(payload.eventId), "eventId invalido (sin el no hay idempotencia)");
      need(typeof payload.ciudadanoId === "string" && ID_RE.test(payload.ciudadanoId), "ciudadanoId invalido");
      need(text(payload.titulo, 300), "titulo invalido");
      await notificationService.onDocumentAuthenticated(payload);
    },

    async documentoAutenticacionFallida(payload) {
      need(payload && typeof payload === "object", "payload invalido");
      need(typeof payload.eventId === "string" && ID_RE.test(payload.eventId), "eventId invalido (sin el no hay idempotencia)");
      need(typeof payload.ciudadanoId === "string" && ID_RE.test(payload.ciudadanoId), "ciudadanoId invalido");
      need(text(payload.titulo, 300), "titulo invalido");
      await notificationService.onDocumentAuthenticationFailed(payload);
    },

    // HU-06.2 (RF-26): correo a una entidad EXTERNA con los enlaces temporales de un paquete documental.
    async paqueteEnvioCorreo(payload) {
      need(payload && typeof payload === "object", "payload invalido");
      need(typeof payload.eventId === "string" && ID_RE.test(payload.eventId), "eventId invalido (sin el no hay idempotencia)");
      need(typeof payload.ciudadanoId === "string" && ID_RE.test(payload.ciudadanoId), "ciudadanoId invalido");
      // UN solo destinatario: sin comas ni punto y coma (el transporte trataria "a@x.co,b@y.co" como dos).
      need(typeof payload.correo === "string" && payload.correo.length <= 200 && SINGLE_EMAIL_RE.test(payload.correo), "correo invalido (un solo destinatario)");
      need(Array.isArray(payload.documentos) && payload.documentos.length >= 1 && payload.documentos.length <= 100, "documentos invalidos");
      for (const d of payload.documentos) {
        need(d && text(d.titulo, 300), "titulo de documento invalido");
        need(typeof d.url === "string" && d.url.length <= 4096 && /^https?:\/\/[^\s]+$/.test(d.url), "url de documento invalida");
      }
      need(text(payload.vencenEn, 40), "vencenEn invalido");
      await notificationService.onPackageEmail(payload);
    },

    async solicitudCreada(payload) {
      need(payload && typeof payload === "object", "payload invalido");
      need(typeof payload.eventId === "string" && ID_RE.test(payload.eventId), "eventId invalido");
      need(typeof payload.solicitudId === "string" && ID_RE.test(payload.solicitudId), "solicitudId invalido (sin el no hay idempotencia)");
      need(typeof payload.ciudadanoId === "string" && ID_RE.test(payload.ciudadanoId), "ciudadanoId invalido");
      need(text(payload.descripcion, 2000), "descripcion invalida"); // limite igual al de ms-documentos (MAX_DESCRIPCION_LENGTH)
      need(text(payload.creadaEn, 40), "creadaEn invalida");
      await notificationService.onDocumentRequestCreated(payload);
    },
  };
}

module.exports = makeEventHandlers;
