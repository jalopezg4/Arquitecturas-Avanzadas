const { PermanentError } = require("../infrastructure/BrokerConsumer");
const logger = require("../tracing/logger");

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// La direccion unica que emite ms-identidad es `<documento>-<8 hex>@carpetacolombia.co`. Aqui solo se comprueba
// que tenga forma de direccion de correo y un tamano razonable: el formato exacto lo decide ms-identidad, y atarlo
// aqui haria que un cambio alla rompiera este consumidor en silencio.
const DIRECCION_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const MAX_DIRECCION = 200;

/**
 * `ciudadano.registrado` (HU-01, paso 7): crea la carpeta del ciudadano recien registrado y guarda su direccion
 * unica como modelo de lectura local (HU-10: es por donde una entidad emisora dirige un documento).
 *
 * Idempotente: `FolderRepository.ensure` no duplica ni pisa el contador de una carpeta existente (por ejemplo, si el
 * ciudadano ya cargo un documento antes de que llegue el evento, o si el evento se entrega dos veces).
 *
 * Un mensaje sin ciudadanoId valido nunca se va a poder procesar: se rechaza (cola de fallidos) en vez de reintentarse.
 * Una direccion ausente o con forma extrana NO invalida el evento: la carpeta se crea igual (los eventos anteriores a
 * HU-10 no la traian) y se deja constancia en el log, sin escribir la direccion.
 */
function makeCitizenRegisteredHandler({ folderRepository }) {
  return async function onCitizenRegistered(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.ciudadanoId !== "string" || !ID_RE.test(payload.ciudadanoId)) {
      throw new PermanentError("ciudadanoId invalido");
    }

    const bruta = payload.direccionUnica;
    let direccion;
    if (typeof bruta === "string" && bruta.length <= MAX_DIRECCION && DIRECCION_RE.test(bruta.trim())) direccion = bruta;
    else if (bruta !== undefined && bruta !== null) logger.warn("carpeta.direccion_unica_descartada", { note: "el evento trae una direccion con formato inesperado" });

    await folderRepository.ensure(payload.ciudadanoId, direccion);
  };
}

module.exports = { makeCitizenRegisteredHandler };
