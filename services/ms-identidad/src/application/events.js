const logger = require("../tracing/logger");

// Con el broker caido, conectar puede tardar mas que el plazo del gateway (10 s): el ciudadano ya esta activo, asi que
// no se le hace esperar (y ver un 504 de un registro que si quedo hecho). Pasado el plazo el evento queda pendiente.
const DEFAULT_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Publica `ciudadano.registrado` para un ciudadano ya ACTIVO. Lo usan la saga de registro y la reconciliacion de
 * pendientes: ambas tienen que producir el mismo mensaje.
 *
 * Un fallo del broker no propaga el error (ADR-04: el aviso no es camino critico; el ciudadano ya quedo activo y
 * confirmado en GovCarpeta): se registra para reconciliar. Devuelve true si el broker confirmo.
 */
async function publishCitizenRegistered(eventPublisher, citizen, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    await withTimeout(eventPublisher.publish("ciudadano.registrado", {
      ciudadanoId: citizen._id.toString(),
      documento: citizen.documento,
      direccionUnica: citizen.direccionUnica,
      // Los consumidores (ms-notificaciones, ms-documentos) necesitan a quien avisar; el evento es interno (broker con
      // TLS en despliegue) y viaja solo a colas propias. Nunca la contrasena ni su resumen.
      nombre: citizen.nombre,
      correo: citizen.correo,
      // HU-06.3 (RF-28): opcional. Viaja como `null` si el ciudadano no lo registro -- nunca se inventa un valor
      // (ms-notificaciones todavia no consume este campo; Paso 3.1 solo lo deja disponible en el evento).
      telefono: citizen.telefono || null,
    }), timeoutMs);
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
