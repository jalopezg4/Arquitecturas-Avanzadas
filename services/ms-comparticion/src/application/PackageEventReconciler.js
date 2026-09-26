const logger = require("../tracing/logger");

/**
 * HU-06.2: reenvia los `paquete.creado` que el broker no confirmo al crearlos. Mismo criterio que los reconciliadores
 * de ms-documentos: solo toca los que tienen al menos `minAgeMs` (uno reciente puede tener la publicacion en curso) y
 * es seguro con varias replicas (ms-documentos procesa cada paquete una sola vez).
 */
class PackageEventReconciler {
  constructor({ packageRepository, packageService, minAgeMs = 60000, batchSize = 50, now = () => new Date() }) {
    this.packages = packageRepository;
    this.service = packageService;
    this.minAgeMs = minAgeMs;
    this.batchSize = batchSize;
    this.now = now;
    this._running = false;
    this._timer = null;
  }

  async reconcileOnce() {
    const olderThan = new Date(this.now().getTime() - this.minAgeMs);
    const pending = await this.packages.findUnpublished({ olderThan, limit: this.batchSize });
    let republished = 0;
    let failed = 0;
    for (const pkg of pending) {
      try {
        await this.service.publish(pkg);
        republished++;
      } catch {
        failed++;
      }
    }
    if (republished || failed) logger.info("paquete.reconciliacion", { reenviados: republished, fallidos: failed });
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
        logger.error("paquete.reconciliacion_fallo", { err });
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

module.exports = PackageEventReconciler;
