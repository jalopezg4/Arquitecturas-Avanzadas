const logger = require("../tracing/logger");

/**
 * HU-06.4: reenvia los `solicitud_oficial.creada` que el broker no confirmo al crearlos (quedarian `resolviendo` para
 * siempre). Mismo criterio que los demas reconciliadores: antiguedad minima, seguro con varias replicas (ms-comparticion
 * responde lo mismo y la resolucion se aplica una sola vez).
 */
class OfficialRequestReconciler {
  constructor({ officialRequestService, minAgeMs = 60000, batchSize = 50, now = () => new Date() }) {
    this.service = officialRequestService;
    this.minAgeMs = minAgeMs;
    this.batchSize = batchSize;
    this.now = now;
    this._running = false;
    this._timer = null;
  }

  async reconcileOnce() {
    const olderThan = new Date(this.now().getTime() - this.minAgeMs);
    const pending = await this.service.findUnpublished({ olderThan, limit: this.batchSize });
    let republished = 0;
    let failed = 0;
    for (const r of pending) {
      try {
        await this.service.publish(r);
        republished++;
      } catch {
        failed++;
      }
    }
    // Avisos a la entidad que el broker no confirmo.
    for (const r of await this.service.findPendingNotices({ olderThan, limit: this.batchSize })) {
      try {
        await this.service.notifyEntity(r);
        republished++;
      } catch {
        failed++;
      }
    }
    if (republished || failed) logger.info("solicitud_oficial.reconciliacion", { reenviados: republished, fallidos: failed });
    return { republished, failed };
  }

  start(intervalMs) {
    this.stop();
    this._timer = setInterval(async () => {
      if (this._running) return;
      this._running = true;
      try {
        await this.reconcileOnce();
      } catch (err) {
        logger.error("solicitud_oficial.reconciliacion_fallo", { err });
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

module.exports = OfficialRequestReconciler;
