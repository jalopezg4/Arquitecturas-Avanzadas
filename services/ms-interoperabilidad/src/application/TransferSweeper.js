const logger = require("../tracing/logger");
const { runWithTrace, newTraceId } = require("../tracing/TraceContext");

/**
 * HU-05c: revisa periodicamente las transferencias vivas cuyo plazo (`revisarEn`) vencio y las hace avanzar: reenvia
 * ordenes que no tuvieron respuesta, reenvia al destino sin confirmacion (5 min) y compensa las que se agotaron. Es lo
 * que evita que una transferencia quede colgada si se pierde un mensaje o se reinicia el servicio.
 *
 * Seguro con varias replicas: cada paso es una transicion condicional; si dos replicas revisan la misma, solo una avanza.
 */
class TransferSweeper {
  constructor({ transferRepository, reviewers, batchSize = 50, now = () => new Date() }) {
    this.transfers = transferRepository;
    this.reviewers = reviewers; // { saliente: {review(t)}, entrante: {review(t)} }
    this.batchSize = batchSize;
    this.now = now;
    this._running = false;
    this._timer = null;
  }

  async sweepOnce() {
    const due = await this.transfers.findDue(this.now(), this.batchSize);
    let reviewed = 0;
    for (const t of due) {
      const reviewer = this.reviewers[t.tipo];
      if (!reviewer) continue;
      try {
        await runWithTrace(newTraceId(), () => reviewer.review(t));
        reviewed++;
      } catch (err) {
        logger.error("transferencia.revision_fallida", { transferenciaId: String(t._id), err });
      }
    }
    return { reviewed, due: due.length };
  }

  start(intervalMs) {
    this.stop();
    this._timer = setInterval(async () => {
      if (this._running) return;
      this._running = true;
      try {
        await this.sweepOnce();
      } catch (err) {
        logger.error("transferencia.barrido_fallido", { err });
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

module.exports = TransferSweeper;
