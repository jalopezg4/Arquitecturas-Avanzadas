const { PermanentError } = require("../infrastructure/BrokerConsumer");

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `ciudadano.registrado` (HU-01, paso 7): crea la carpeta del ciudadano recien registrado.
 * Idempotente: `FolderRepository.ensure` no duplica ni pisa una carpeta existente (por ejemplo, si el ciudadano ya
 * cargo un documento antes de que llegue el evento, o si el evento se entrega dos veces).
 *
 * Un mensaje sin ciudadanoId valido nunca se va a poder procesar: se rechaza (cola de fallidos) en vez de reintentarse.
 */
function makeCitizenRegisteredHandler({ folderRepository }) {
  return async function onCitizenRegistered(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.ciudadanoId !== "string" || !ID_RE.test(payload.ciudadanoId)) {
      throw new PermanentError("ciudadanoId invalido");
    }
    await folderRepository.ensure(payload.ciudadanoId);
  };
}

module.exports = { makeCitizenRegisteredHandler };
