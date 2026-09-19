const logger = require("../tracing/logger");
const { publishCitizenRegistered } = require("./events");

/**
 * Resuelve los registros que quedaron `pendiente` por un fallo AMBIGUO al llamar a registerCitizen (timeout o 5xx:
 * GovCarpeta pudo haber aceptado o no). Sin este proceso, ese documento respondia 409 para siempre.
 *
 * Se pregunta a GovCarpeta (`validateCitizen`), que no dice a que operador pertenece el ciudadano pero si si esta
 * afiliado:
 *   - disponible  -> GovCarpeta nunca lo acepto: se BORRA el pendiente y el ciudadano puede volver a registrarse.
 *   - afiliado    -> se asume que lo acepto NUESTRO intento: antes de registrarlo la saga comprobo que estaba
 *                    disponible, asi que quedar afiliado despues es, con muy alta probabilidad, obra de nuestra llamada.
 *                    Se ACTIVA y se publica `ciudadano.registrado`, como habria hecho la saga.
 *   - GovCarpeta no responde -> no se decide nada; se reintenta en la siguiente pasada.
 *
 * Limite conocido: si OTRO operador afilio a ese ciudadano justo entre la validacion y nuestra reconciliacion, se
 * activaria uno que no es nuestro. GovCarpeta no ofrece como distinguirlo.
 *
 * - Solo toca pendientes con al menos `minAgeMs`: uno reciente puede estar aun dentro de su saga.
 * - Las transiciones son condicionales (solo si sigue `pendiente`), asi que dos replicas o una saga tardia no chocan.
 */
class PendingRegistrationReconciler {
  constructor({ citizenRepository, govCarpetaClient, eventPublisher, auditLogger, minAgeMs = 5 * 60000, batchSize = 50, now = () => new Date() }) {
    this.citizenRepository = citizenRepository;
    this.govCarpetaClient = govCarpetaClient;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.minAgeMs = minAgeMs;
    this.batchSize = batchSize;
    this.now = now;
    this._running = false;
    this._timer = null;
  }

  async _audit(documento, outcome, reason) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({ actor: String(documento), actorType: "ciudadano", action: "ciudadano.registrar", resource: `ciudadano:${documento}`, resourceOwner: String(documento), outcome, reason });
    } catch (err) {
      logger.error("audit.write_failed", { action: "ciudadano.registrar", err });
    }
  }

  /** Una pasada. Devuelve cuantos pendientes se activaron, se descartaron y se dejaron para despues. */
  async reconcileOnce() {
    const olderThan = new Date(this.now().getTime() - this.minAgeMs);
    const pending = await this.citizenRepository.findStalePending({ olderThan, limit: this.batchSize });
    const result = { activated: 0, discarded: 0, skipped: 0, republished: 0 };
    for (const citizen of pending) {
      try {
        const { available } = await this.govCarpetaClient.validateCitizen(citizen.documento);
        if (available) {
          const { deletedCount } = await this.citizenRepository.deletePending(citizen._id);
          if (deletedCount) {
            result.discarded++;
            logger.info("saga.reconciliacion", { accion: "descartado", motivo: "govcarpeta_no_lo_acepto", ciudadanoId: citizen._id.toString() });
            await this._audit(citizen.documento, "fallo", "reconciliado_no_aceptado_por_govcarpeta");
          }
          continue;
        }
        const active = await this.citizenRepository.activatePending(citizen._id);
        if (!active) continue; // otra replica o la propia saga ya lo resolvio
        result.activated++;
        logger.info("saga.reconciliacion", { accion: "activado", motivo: "govcarpeta_lo_acepto", ciudadanoId: active._id.toString() });
        await this._audit(active.documento, "exito", "reconciliado");
        if (await publishCitizenRegistered(this.eventPublisher, active)) await this.citizenRepository.markEventPublished(active._id);
      } catch (err) {
        result.skipped++;
        logger.warn("saga.reconciliacion_omitida", { ciudadanoId: citizen._id.toString(), err });
      }
    }

    // Segunda tarea: ciudadanos ya activos cuyo evento no llego al broker (welcome/carpeta pendientes). El consumidor
    // es idempotente por ciudadano, asi que un duplicado no reenvia el correo.
    const unpublished = await this.citizenRepository.findUnpublishedActive({ olderThan, limit: this.batchSize });
    for (const citizen of unpublished) {
      try {
        if (await publishCitizenRegistered(this.eventPublisher, citizen)) {
          await this.citizenRepository.markEventPublished(citizen._id);
          result.republished++;
        } else {
          result.skipped++;
        }
      } catch (err) {
        result.skipped++;
        logger.warn("saga.reconciliacion_omitida", { ciudadanoId: citizen._id.toString(), err });
      }
    }
    return result;
  }

  /** Repite la pasada cada `intervalMs`. Nunca se solapa consigo misma ni deja caer el proceso por un error. */
  start(intervalMs) {
    this.stop();
    this._timer = setInterval(async () => {
      if (this._running) return;
      this._running = true;
      try {
        await this.reconcileOnce();
      } catch (err) {
        logger.error("saga.reconciliacion_fallo", { err });
      } finally {
        this._running = false;
      }
    }, intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = PendingRegistrationReconciler;
