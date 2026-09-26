const { PermanentError } = require("../infrastructure/BrokerConsumer");

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * `paquete.procesado` (HU-06.2, lo publica ms-documentos): los documentos son (o no) del ciudadano y el paquete ya se
 * entrego en la carpeta institucional o por correo. Idempotente: solo el primer resultado cambia el paquete.
 */
function makePackageProcessedHandler({ packageService }) {
  return async function onPackageProcessed(payload) {
    if (!payload || typeof payload !== "object") throw new PermanentError("payload invalido");
    if (typeof payload.paqueteId !== "string" || !OBJECT_ID_RE.test(payload.paqueteId)) throw new PermanentError("paqueteId invalido");
    if (typeof payload.ok !== "boolean") throw new PermanentError("ok invalido");
    if (payload.ok && !Array.isArray(payload.documentos)) throw new PermanentError("documentos invalidos");
    await packageService.onProcessed({
      paqueteId: payload.paqueteId,
      ok: payload.ok,
      motivo: typeof payload.motivo === "string" ? payload.motivo.slice(0, 200) : undefined,
      documentos: payload.documentos,
      remitenteDireccionUnica: typeof payload.remitenteDireccionUnica === "string" ? payload.remitenteDireccionUnica.slice(0, 200) : undefined,
    });
  };
}

module.exports = { makePackageProcessedHandler };
