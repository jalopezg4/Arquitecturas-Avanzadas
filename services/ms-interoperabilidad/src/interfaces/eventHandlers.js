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
    const direccion = text(payload.direccion, 300) ? payload.direccion.trim() : null;
    await citizenRepository.upsert({ ciudadanoId: payload.ciudadanoId, documento: payload.documento, nombre: payload.nombre.trim(), correo: payload.correo.trim(), direccionUnica, direccion });
  };
}

/**
 * `transferencia.carpeta_exportada` (HU-05c, lo publica ms-documentos): la carpeta ya esta bloqueada y trae una URL
 * prefirmada por documento. Un mensaje mal formado no se puede aplicar: cola de fallidos (el barrido desiste luego).
 */
function makeFolderExportedHandler({ sagaService, maxDocuments = 500 }) {
  return async function onFolderExported(payload) {
    need(payload && typeof payload === "object", "payload invalido");
    need(typeof payload.transferenciaId === "string" && ID_RE.test(payload.transferenciaId), "transferenciaId invalido");
    need(typeof payload.ok === "boolean", "ok invalido");
    if (payload.ok) {
      need(Array.isArray(payload.documentos) && payload.documentos.length <= maxDocuments, "documentos invalidos");
      for (const d of payload.documentos) need(d && typeof d.url === "string" && d.url.length <= 4096, "documento sin url");
    }
    await sagaService.onFolderExported(payload);
  };
}

/** HU-05c (destino): respuestas de ms-documentos (importacion) y ms-identidad (registro). */
function makeReceiverHandlers({ receiverService }) {
  const base = (payload) => {
    need(payload && typeof payload === "object", "payload invalido");
    need(typeof payload.transferenciaId === "string" && ID_RE.test(payload.transferenciaId), "transferenciaId invalido");
    need(typeof payload.ok === "boolean", "ok invalido");
    return { transferenciaId: payload.transferenciaId, ok: payload.ok, motivo: typeof payload.motivo === "string" ? payload.motivo.slice(0, 200) : undefined };
  };
  return {
    async documentosImportados(payload) {
      await receiverService.onDocumentsImported(base(payload));
    },
    async ciudadanoImportado(payload) {
      const direccionUnica = typeof payload.direccionUnica === "string" && payload.direccionUnica.length <= 200 && EMAIL_RE.test(payload.direccionUnica) ? payload.direccionUnica : undefined;
      await receiverService.onCitizenRegistered({ ...base(payload), direccionUnica });
    },
  };
}

module.exports = { makeCitizenRegisteredHandler, makeFolderExportedHandler, makeReceiverHandlers, need, ID_RE, EMAIL_RE };
