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
 * unica (HU-10: es por donde una entidad emisora dirige un documento) y su cedula (HU-04: identificacion ante
 * GovCarpeta) como modelo de lectura local.
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

    // HU-04: la cedula es la identificacion del ciudadano ante GovCarpeta. Mismo criterio que la direccion: si falta o
    // es invalida la carpeta se crea igual (sin ella solo no se podra pedir autenticacion); nunca se escribe en el log.
    let documento;
    if (Number.isSafeInteger(payload.documento) && payload.documento > 0) documento = payload.documento;
    else if (payload.documento !== undefined && payload.documento !== null) logger.warn("carpeta.documento_descartado", { note: "el evento trae un documento con formato inesperado" });

    await folderRepository.ensure(payload.ciudadanoId, direccion, documento);
  };
}

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** Campos comunes de los resultados de HU-04; un mensaje que no los cumple nunca se va a poder aplicar. */
function parseAuthResult(payload) {
  if (!payload || typeof payload !== "object") throw new PermanentError("el mensaje no es un objeto");
  if (typeof payload.documentoId !== "string" || !OBJECT_ID_RE.test(payload.documentoId)) throw new PermanentError("documentoId invalido");
  if (!Number.isSafeInteger(payload.intento) || payload.intento < 1) throw new PermanentError("intento invalido");
  return payload;
}

/**
 * HU-04: resultado de la autenticacion que publica ms-autenticacion. Idempotentes: el servicio aplica la transicion
 * solo si el documento sigue `en autenticacion` en ese mismo intento, asi que una reentrega no hace nada.
 */
function makeAuthenticationResultHandlers({ documentAuthenticationService }) {
  return {
    async autenticado(payload) {
      const { documentoId, intento, autenticadoEn } = parseAuthResult(payload);
      await documentAuthenticationService.onAuthenticated({ documentoId, intento, autenticadoEn });
    },
    async autenticacionFallida(payload) {
      const { documentoId, intento, motivo } = parseAuthResult(payload);
      await documentAuthenticationService.onAuthenticationFailed({ documentoId, intento, motivo: typeof motivo === "string" ? motivo.slice(0, 40) : undefined });
    },
  };
}

module.exports = { makeCitizenRegisteredHandler, makeAuthenticationResultHandlers };
