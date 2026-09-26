const { PermanentError } = require("../infrastructure/BrokerConsumer");

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function need(cond, message) {
  if (!cond) throw new PermanentError(message);
}
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/**
 * `ciudadano.registrado` (HU-01, lo publica ms-identidad): guarda la copia local que necesita una transferencia
 * saliente. Un evento viejo sin nombre/correo no sirve para transferir: va a la cola de fallidos.
 */
function makeCitizenRegisteredHandler({ citizenRepository }) {
  return async function onCitizenRegistered(payload) {
    need(payload && typeof payload === "object", "payload invalido");
    need(typeof payload.ciudadanoId === "string" && ID_RE.test(payload.ciudadanoId), "ciudadanoId invalido");
    need(Number.isSafeInteger(payload.documento) && payload.documento > 0, "documento invalido");
    need(text(payload.nombre, 200), "nombre invalido o ausente");
    need(typeof payload.correo === "string" && payload.correo.length <= 200 && EMAIL_RE.test(payload.correo), "correo invalido o ausente");
    const direccionUnica = typeof payload.direccionUnica === "string" && payload.direccionUnica.length <= 200 && EMAIL_RE.test(payload.direccionUnica) ? payload.direccionUnica : null;
    await citizenRepository.upsert({ ciudadanoId: payload.ciudadanoId, documento: payload.documento, nombre: payload.nombre.trim(), correo: payload.correo.trim(), direccionUnica });
  };
}

module.exports = { makeCitizenRegisteredHandler, need, ID_RE, EMAIL_RE };
