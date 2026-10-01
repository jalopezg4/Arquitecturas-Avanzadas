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

/**
 * Otro proceso tiene el intento `procesando` y su reclamo aun es reciente. NO es un duplicado que se pueda confirmar:
 * si ese proceso murio, confirmar perderia el resultado para siempre. Se lanza como error transitorio: el consumidor
 * reintenta con espera creciente y, cuando el reclamo vence (`staleClaimMs`), esta entrega lo retoma.
 */
class IntentoEnCursoError extends Error {
  constructor() {
    super("el intento lo esta procesando otra entrega; se reintentara");
    this.name = "IntentoEnCursoError";
  }
}

/**
 * Cuanto puede tardar, como maximo, un intento vivo: todas las llamadas a GovCarpeta con su timeout, las esperas entre
 * ellas (Retry-After acotado a 5 s) y un margen para firmar la URL y publicar. Un reclamo mas viejo que esto es de un
 * proceso que murio. Deriva de la configuracion para que subir el timeout no deje reclamos "vencidos" en curso.
 */
function staleClaimMsFor({ timeoutMs, maxAttempts, baseDelayMs }) {
  const esperas = Array.from({ length: Math.max(0, maxAttempts - 1) }, (_, i) => Math.max(5000, baseDelayMs * 2 ** i));
  return maxAttempts * timeoutMs + esperas.reduce((a, b) => a + b, 0) + 15000;
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
      if (!attempt || attempt.estado === "procesando") {
        logger.info("autenticacion.intento_en_curso", { documentoId: req.documentoId, intento: req.intento, note: "se reintenta; si el otro proceso murio, se retoma al vencer su reclamo" });
        throw new IntentoEnCursoError();
      }
      logger.info("autenticacion.duplicado", { documentoId: req.documentoId, intento: req.intento });
      return { estado: attempt.estado, motivo: attempt.motivo, duplicado: true };
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

    let resolved;
    try {
      resolved = await this.attempts.resolve(req.eventId, { estado, motivo, llamadasGovCarpeta: llamadas, resueltoEn: this.now() });
    } catch (err) {
      // GovCarpeta ya respondio pero no se pudo guardar: se libera el reclamo para que el reintento lo retome (volvera
      // a llamar; es un PUT sobre el mismo documento). Sin esto, el reintento lo veria `procesando` y lo perderia.
      await this.attempts.release(req.eventId).catch((e) => logger.error("autenticacion.no_se_pudo_liberar", { err: e }));
      throw err;
    }
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

module.exports = { AuthenticationService, IntentoEnCursoError, staleClaimMsFor, resultPayload, AUTENTICADO, FALLIDA };
