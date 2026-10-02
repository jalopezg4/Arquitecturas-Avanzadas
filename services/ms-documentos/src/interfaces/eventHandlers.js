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
function makeCitizenRegisteredHandler({ folderRepository, identityDocumentService }) {
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

    // HU-01, paso 13: la cedula firmada por la Registraduria, solo para un registro NUEVO (quien llega por
    // transferencia trae sus documentos del operador de origen). Si falla, el error sube y el evento se reintenta.
    const nombre = typeof payload.nombre === "string" ? payload.nombre.trim() : "";
    if (identityDocumentService && payload.origen === "registro" && documento && nombre && nombre.length <= 200) {
      await identityDocumentService.issueSignedIdCard({ ciudadanoId: payload.ciudadanoId, documento, nombre });
    }
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

/** HU-05c: ordenes de la saga de transferencia (las publica ms-interoperabilidad). */
function parseTransferOrder(payload) {
  if (!payload || typeof payload !== "object") throw new PermanentError("el mensaje no es un objeto");
  if (typeof payload.transferenciaId !== "string" || !ID_RE.test(payload.transferenciaId)) throw new PermanentError("transferenciaId invalido");
  if (typeof payload.ciudadanoId !== "string" || !ID_RE.test(payload.ciudadanoId)) throw new PermanentError("ciudadanoId invalido");
  return { transferenciaId: payload.transferenciaId, ciudadanoId: payload.ciudadanoId };
}

function makeTransferHandlers({ transferFolderService }) {
  return {
    async exportar(payload) {
      await transferFolderService.export(parseTransferOrder(payload));
    },
    async transferido(payload) {
      await transferFolderService.purge(parseTransferOrder(payload));
    },
    async cancelada(payload) {
      await transferFolderService.cancel(parseTransferOrder(payload));
    },
  };
}

/** HU-05c (destino): importar los documentos del ciudadano que llega, o revertir la importacion. */
function makeTransferImportHandlers({ transferImportService, maxDocuments = 500 }) {
  return {
    async importar(payload) {
      const { transferenciaId, ciudadanoId } = parseTransferOrder(payload);
      if (!OBJECT_ID_RE.test(ciudadanoId)) throw new PermanentError("ciudadanoId invalido");
      if (!Array.isArray(payload.documentos) || payload.documentos.length > maxDocuments) throw new PermanentError("documentos invalidos");
      for (const d of payload.documentos) {
        if (!d || typeof d.clave !== "string" || !ID_RE.test(d.clave) || typeof d.url !== "string" || d.url.length > 4096) throw new PermanentError("documento invalido");
      }
      const documento = Number.isSafeInteger(payload.documento) && payload.documento > 0 ? payload.documento : undefined;
      const direccionUnica = typeof payload.direccionUnica === "string" && payload.direccionUnica.length <= MAX_DIRECCION && DIRECCION_RE.test(payload.direccionUnica) ? payload.direccionUnica : undefined;
      await transferImportService.import({ transferenciaId, ciudadanoId, documento, direccionUnica, documentos: payload.documentos });
    },
    async revertir(payload) {
      await transferImportService.revert(parseTransferOrder(payload));
    },
  };
}

/** HU-06.2: `paquete.creado` (de ms-comparticion). Un mensaje mal formado nunca se podra entregar: cola de fallidos. */
function makePackageCreatedHandler({ packageDeliveryService, maxDocumentos = 100 }) {
  return async function onPackageCreated(payload) {
    if (!payload || typeof payload !== "object") throw new PermanentError("el mensaje no es un objeto");
    if (typeof payload.paqueteId !== "string" || !OBJECT_ID_RE.test(payload.paqueteId)) throw new PermanentError("paqueteId invalido");
    if (typeof payload.ciudadanoId !== "string" || !ID_RE.test(payload.ciudadanoId)) throw new PermanentError("ciudadanoId invalido");
    if (!Array.isArray(payload.documentoIds) || !payload.documentoIds.length || payload.documentoIds.length > maxDocumentos) throw new PermanentError("documentoIds invalidos");
    if (!payload.documentoIds.every((id) => typeof id === "string" && OBJECT_ID_RE.test(id))) throw new PermanentError("documentoIds invalidos");
    if (payload.canal === "carpeta_institucional") {
      if (typeof payload.institutionId !== "string" || !ID_RE.test(payload.institutionId)) throw new PermanentError("institutionId invalido");
    } else if (payload.canal === "correo") {
      if (typeof payload.correoDestino !== "string" || payload.correoDestino.length > 200 || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(payload.correoDestino)) throw new PermanentError("correoDestino invalido");
    } else {
      throw new PermanentError("canal invalido");
    }
    await packageDeliveryService.deliver({
      paqueteId: payload.paqueteId,
      ciudadanoId: payload.ciudadanoId,
      documentoIds: payload.documentoIds,
      canal: payload.canal,
      institutionId: payload.institutionId || null,
      correoDestino: payload.correoDestino || null,
      nombreDestino: typeof payload.nombreDestino === "string" ? payload.nombreDestino.slice(0, 150) : null,
    });
  };
}

/** HU-06.4: `solicitud_oficial.resuelta` (de ms-comparticion): a que entidad corresponde el NIT (o a ninguna). */
function makeOfficialRequestResolvedHandler({ officialRequestService }) {
  return async function onResolved(payload) {
    if (!payload || typeof payload !== "object") throw new PermanentError("el mensaje no es un objeto");
    if (typeof payload.solicitudOficialId !== "string" || !OBJECT_ID_RE.test(payload.solicitudOficialId)) throw new PermanentError("solicitudOficialId invalido");
    const institutionId = payload.institutionId === null || payload.institutionId === undefined ? null : payload.institutionId;
    if (institutionId !== null && (typeof institutionId !== "string" || !ID_RE.test(institutionId))) throw new PermanentError("institutionId invalido");
    await officialRequestService.onResolved({
      solicitudOficialId: payload.solicitudOficialId,
      institutionId,
      nombre: typeof payload.nombre === "string" ? payload.nombre.slice(0, 200) : null,
      correoContacto: typeof payload.correoContacto === "string" ? payload.correoContacto : null,
    });
  };
}

module.exports = { makeCitizenRegisteredHandler, makeAuthenticationResultHandlers, makeTransferHandlers, makeTransferImportHandlers, makePackageCreatedHandler, makeOfficialRequestResolvedHandler };
