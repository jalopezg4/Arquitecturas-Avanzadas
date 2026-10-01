const logger = require("../tracing/logger");

/**
 * HU-05c: ningun ciudadano transferido se queda sin codigo de activacion. Busca ciudadanos activos SIN contrasena a los
 * que nunca se les emitio un codigo (p. ej. los activo PendingRegistrationReconciler) o cuyo codigo no se confirmo en el
 * broker (`activacionPublicada: false`), y les emite uno nuevo. El codigo no se guarda en claro, asi que no se puede
 * "reenviar": se reemplaza (el anterior nunca llego a confirmarse).
 *
 * Mismo criterio que los demas reconciliadores: solo toca registros con al menos `minAgeMs` sin cambios (uno reciente
 * puede tener su emision en curso) y es seguro con varias replicas (la emision es una escritura condicional).
 */
class ActivationReconciler {
  constructor({ citizenModel, activationService, minAgeMs = 60000, batchSize = 50, now = () => new Date() }) {
    this.Citizen = citizenModel;
    this.activation = activationService;
    this.minAgeMs = minAgeMs;
    this.batchSize = batchSize;
    this.now = now;
    this._running = false;
    this._timer = null;
  }

  async reconcileOnce() {
    const olderThan = new Date(this.now().getTime() - this.minAgeMs);
    const pendientes = await this.Citizen.find(
      {
        estado: "activo",
        passwordHash: null,
        $or: [
          { activacionHash: null, updatedAt: { $lte: olderThan } },
          { activacionPublicada: false, activacionEnviadaEn: { $lte: olderThan } },
        ],
      },
      { _id: 1 }
    )
      .limit(this.batchSize)
      .lean();
    let emitidos = 0;
    for (const c of pendientes) {
      if (await this.activation.issue(c._id, { onlyIfMissing: true }).catch(() => false)) emitidos++;
    }
    if (pendientes.length) logger.info("ciudadano.activacion_reconciliacion", { pendientes: pendientes.length, emitidos });
    return { emitidos, pendientes: pendientes.length };
  }

  start(intervalMs) {
    this.stop();
    this._timer = setInterval(async () => {
      if (this._running) return;
      this._running = true;
      try {
        await this.reconcileOnce();
      } catch (err) {
        logger.error("ciudadano.activacion_reconciliacion_fallo", { err });
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

module.exports = ActivationReconciler;
