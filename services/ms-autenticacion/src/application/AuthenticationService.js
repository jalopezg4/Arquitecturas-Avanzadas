const logger = require("../tracing/logger");

const AUTENTICADO = "documento.autenticado";
const FALLIDA = "documento.autenticacion_fallida";

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Contenido de los eventos de resultado. `eventId` deterministico por intento y resultado (idempotencia aguas abajo). */
function resultPayload(req, attempt) {
  const base = { documentoId: req.documentoId, ciudadanoId: req.ciudadanoId, titulo: req.titulo, intento: req.intento };
  const cuando = new Date(attempt.resueltoEn).toISOString();
  if (attempt.estado === "autenticado") return { eventId: `${req.documentoId}-auth-${req.intento}-ok`, ...base, autenticadoEn: cuando };
  return { eventId: `${req.documentoId}-auth-${req.intento}-fallo`, ...base, motivo: attempt.motivo, fallidoEn: cuando };
}

/**
 * HU-04: procesa UNA solicitud de autenticacion (`documento.autenticacion_solicitada`).
 *
 *   1. reclama el intento (idempotencia: una reentrega no vuelve a llamar a GovCarpeta)
 *   2. firma una URL de lectura de 15 minutos sobre el objeto
 *   3. PUT /apis/authenticateDocument con {cedula, URL, titulo} -- hasta 3 intentos con espera creciente
 *   4. registra el resultado y publica `documento.autenticado` o `documento.autenticacion_fallida`
 *
 * Devuelve `{estado, motivo}`. Quien consume decide que hacer con el mensaje: `motivo: "no_disponible"` (reintentos
 * agotados) debe ir a la cola de fallidos, como pide la HU. Un error inesperado (p. ej. el broker no confirma el
 * resultado) se propaga para que el consumidor reintente; el intento queda liberado o resuelto, nunca colgado.
 */
class AuthenticationService {
  constructor({ attemptRepository, presignedUrlService, govCarpetaClient, eventPublisher, auditLogger, eventPublishTimeoutMs = 3000, staleClaimMs = 5 * 60 * 1000, now = () => new Date() }) {
    this.attempts = attemptRepository;
    this.presigned = presignedUrlService;
    this.govCarpeta = govCarpetaClient;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.staleClaimMs = staleClaimMs;
    this.now = now;
  }

  async process(req) {
    const { claimed, attempt } = await this.attempts.claim(req, { now: this.now(), staleMs: this.staleClaimMs });
    if (!claimed) {
      if (attempt && attempt.estado !== "procesando" && !attempt.resultadoPublicado) {
        // Ya se resolvio pero el resultado no alcanzo a publicarse: se republica el MISMO resultado, sin llamar a GovCarpeta.
        await this._publish(req, attempt);
        return { estado: attempt.estado, motivo: attempt.motivo, republicado: true };
      }
      logger.info("autenticacion.duplicado", { documentoId: req.documentoId, intento: req.intento });
      return { estado: attempt ? attempt.estado : "procesando", motivo: attempt ? attempt.motivo : null, duplicado: true };
    }

    let estado;
    let motivo = null;
    let llamadas = 0;
    try {
      const { url } = await this.presigned.generate(req.storageKey, req.ciudadanoId);
      const res = await this.govCarpeta.authenticateDocument({ idCitizen: req.documento, urlDocument: url, documentTitle: req.titulo });
      estado = "autenticado";
      llamadas = res.intentos;
    } catch (err) {
      if (err && err.definitive) {
        estado = "fallido";
        motivo = "rechazado";
        llamadas = err.intentos || 1;
      } else if (err && err.code === "GOVCARPETA_UNAVAILABLE") {
        estado = "fallido";
        motivo = "no_disponible";
        llamadas = err.intentos || 0;
      } else {
        // Fallo propio (p. ej. no se pudo firmar la URL): se libera el reclamo para que el reintento lo retome.
        await this.attempts.release(req.eventId).catch((e) => logger.error("autenticacion.no_se_pudo_liberar", { err: e }));
        throw err;
      }
    }

    const resolved = await this.attempts.resolve(req.eventId, { estado, motivo, llamadasGovCarpeta: llamadas, resueltoEn: this.now() });
    logger.info("autenticacion.resultado", { documentoId: req.documentoId, intento: req.intento, estado, motivo, llamadas });
    await this._audit(req, estado, motivo, llamadas);
    await this._publish(req, resolved);
    return { estado, motivo };
  }

  async _publish(req, attempt) {
    const routingKey = attempt.estado === "autenticado" ? AUTENTICADO : FALLIDA;
    await withTimeout(this.eventPublisher.publish(routingKey, resultPayload(req, attempt)), this.eventPublishTimeoutMs);
    await this.attempts.markResultPublished(req.eventId);
  }

  async _audit(req, estado, motivo, llamadas) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({
        actor: "ms-autenticacion",
        actorType: "sistema",
        action: "documento.autenticar_govcarpeta",
        resource: `documento:${req.documentoId}`,
        resourceOwner: req.ciudadanoId,
        // Actua sobre el documento de un ciudadano porque ESE ciudadano lo pidio (HU-04): acceso delegado, no ajeno.
        delegated: true,
        outcome: estado === "autenticado" ? "exito" : "fallo",
        reason: motivo || undefined,
        metadata: { intento: req.intento, llamadasGovCarpeta: llamadas },
      });
    } catch (err) {
      logger.error("audit.write_failed", { action: "documento.autenticar_govcarpeta", err });
    }
  }
}

module.exports = { AuthenticationService, resultPayload, AUTENTICADO, FALLIDA };
