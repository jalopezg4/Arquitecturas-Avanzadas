const logger = require("../tracing/logger");
const { documentoCargadoPayload } = require("./events");

/**
 * Reenvia los `documento.cargado` que no se pudieron publicar al cargar (broker caido o sin confirmar): esos
 * documentos quedan con `eventoPublicado:false`. Sin este proceso el ciudadano nunca recibia el aviso.
 *
 * - Solo toca documentos con al menos `minAgeMs` de antiguedad: uno recien cargado puede tener su publicacion todavia
 *   en curso, y reenviarlo enseguida duplicaria el evento.
 * - Es seguro ejecutarlo en varias replicas o repetirlo: el evento lleva un `eventId` deterministico y el consumidor
 *   es idempotente, asi que un duplicado no genera un segundo correo.
 * - Un documento que falla no impide reenviar los demas.
 */
class EventReconciler {
  constructor({ documentRepository, eventPublisher, minAgeMs = 60000, batchSize = 50, publishTimeoutMs = 3000, now = () => new Date() }) {
    this.documentRepository = documentRepository;
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
    const docs = await this.documentRepository.findUnpublished({ olderThan, limit: this.batchSize });
    let republished = 0;
    let failed = 0;
    for (const doc of docs) {
      try {
        await this._publishWithTimeout(documentoCargadoPayload(doc));
        await this.documentRepository.markEventPublished(doc._id);
        republished++;
      } catch (err) {
        failed++;
        logger.warn("documento.reenvio_fallido", { documentoId: doc._id.toString(), err });
      }
    }
    if (republished || failed) logger.info("documento.reconciliacion", { reenviados: republished, fallidos: failed });
    return { republished, failed };
  }

  _publishWithTimeout(payload) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${this.publishTimeoutMs} ms`)), this.publishTimeoutMs);
    });
    return Promise.race([this.eventPublisher.publish("documento.cargado", payload), timeout]).finally(() => clearTimeout(timer));
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
        logger.error("documento.reconciliacion_fallo", { err });
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

module.exports = EventReconciler;
