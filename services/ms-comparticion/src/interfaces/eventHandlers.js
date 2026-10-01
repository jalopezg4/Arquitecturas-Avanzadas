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

const RESUELTA = "solicitud_oficial.resuelta";

/**
 * `solicitud_oficial.creada` (HU-06.4, la publica ms-documentos): responde a que institucion corresponde el NIT (o a
 * ninguna). Si el broker no confirma la respuesta se lanza y el mensaje se reintenta (responder dos veces es inocuo).
 */
function makeOfficialRequestHandler({ institutionService, eventPublisher, timeoutMs = 3000 }) {
  return async function onOfficialRequest(payload) {
    if (!payload || typeof payload !== "object") throw new PermanentError("payload invalido");
    if (typeof payload.solicitudOficialId !== "string" || !OBJECT_ID_RE.test(payload.solicitudOficialId)) throw new PermanentError("solicitudOficialId invalido");
    if (typeof payload.nit !== "string" || payload.nit.length > 20) throw new PermanentError("nit invalido");
    const found = await institutionService.resolveByNit(payload.nit);
    let timer;
    await Promise.race([
      // correoContacto: para avisarle a la entidad que tiene una solicitud nueva en su bandeja.
      eventPublisher.publish(RESUELTA, { solicitudOficialId: payload.solicitudOficialId, institutionId: found ? found.institutionId : null, nombre: found ? found.nombre : null, correoContacto: found ? found.correoContacto : null }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("sin confirmacion del broker")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };
}

module.exports = { makePackageProcessedHandler, makeOfficialRequestHandler };
