const logger = require("../tracing/logger");
const { solicitudCreadaPayload } = require("./solicitudEvents");

/**
 * Reenvia los `solicitud.creada` que no se pudieron publicar al crear la solicitud (broker caido o sin
 * confirmar): esas solicitudes quedan con `eventoPublicado:false`. Sin este proceso el ciudadano nunca recibia
 * el aviso. Mismo patron, estructura y garantias que `EventReconciler` (para `documento.cargado`) -- clase
 * separada a proposito, para no acoplar el reenvio de solicitudes al de documentos ni arriesgar su
 * comportamiento ya probado.
 *
 * - Solo toca solicitudes con al menos `minAgeMs` de antiguedad: una recien creada puede tener su publicacion
 *   todavia en curso, y reenviarla enseguida duplicaria el evento.
 * - Es seguro ejecutarlo en varias replicas o repetirlo: el evento lleva un `eventId` deterministico y el
 *   consumidor debe ser idempotente (mismo criterio que `documento.cargado`/`ciudadano.registrado`), asi que un
 *   duplicado no genera un segundo aviso.
 * - Una solicitud que falla no impide reenviar las demas.
 */
class SolicitudEventReconciler {
  constructor({ solicitudRepository, eventPublisher, minAgeMs = 60000, batchSize = 50, publishTimeoutMs = 3000, now = () => new Date() }) {
    this.solicitudRepository = solicitudRepository;
    this.eventPublisher = eventPublisher;
    this.minAgeMs = minAgeMs;
    this.batchSize = batchSize;
    this.publishTimeoutMs = publishTimeoutMs;
    this.now = now;
    this._running = false;
    this._timer = null;
  }

  /** Una pasada. Devuelve cuantos eventos reenvio y cuantos fallaron. */
  async reconcileOnce() {
    const olderThan = new Date(this.now().getTime() - this.minAgeMs);
    const solicitudes = await this.solicitudRepository.findUnpublished({ olderThan, limit: this.batchSize });
    let republished = 0;
    let failed = 0;
    for (const solicitud of solicitudes) {
      try {
        await this._publishWithTimeout(solicitudCreadaPayload(solicitud));
        await this.solicitudRepository.markEventPublished(solicitud._id);
        republished++;
      } catch (err) {
        failed++;
        logger.warn("solicitud.reenvio_fallido", { solicitudId: solicitud._id.toString(), err });
      }
    }
    if (republished || failed) logger.info("solicitud.reconciliacion", { reenviados: republished, fallidos: failed });
    return { republished, failed };
  }

  _publishWithTimeout(payload) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${this.publishTimeoutMs} ms`)), this.publishTimeoutMs);
    });
    return Promise.race([this.eventPublisher.publish("solicitud.creada", payload), timeout]).finally(() => clearTimeout(timer));
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
        logger.error("solicitud.reconciliacion_fallo", { err });
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

module.exports = SolicitudEventReconciler;
