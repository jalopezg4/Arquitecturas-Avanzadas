const logger = require("../tracing/logger");

/**
 * Publica `ciudadano.registrado` para un ciudadano ya ACTIVO. Lo usan la saga de registro y la reconciliacion de
 * pendientes: ambas tienen que producir el mismo mensaje.
 *
 * Un fallo del broker no propaga el error (ADR-04: el aviso no es camino critico; el ciudadano ya quedo activo y
 * confirmado en GovCarpeta): se registra para reconciliar. Devuelve true si el broker confirmo.
 */
async function publishCitizenRegistered(eventPublisher, citizen) {
  try {
    await eventPublisher.publish("ciudadano.registrado", {
      ciudadanoId: citizen._id.toString(),
      documento: citizen.documento,
      direccionUnica: citizen.direccionUnica,
      // Los consumidores (ms-notificaciones, ms-documentos) necesitan a quien avisar; el evento es interno (broker con
      // TLS en despliegue) y viaja solo a colas propias. Nunca la contrasena ni su resumen.
      nombre: citizen.nombre,
      correo: citizen.correo,
    });
    return true;
  } catch (err) {
    logger.error("saga.paso_fallido", {
      step: "publicar_evento",
      ciudadanoId: citizen._id.toString(),
      note: "requiere reconciliacion",
      err,
    });
    return false;
  }
}

module.exports = { publishCitizenRegistered };
