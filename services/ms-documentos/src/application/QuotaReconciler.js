const mongoose = require("mongoose");
const logger = require("../tracing/logger");

/**
 * RNF-04: mantiene la cuota de cada carpeta (`Folder.cupos`) igual a los documentos que de verdad ocupan cupo
 * (temporales y en autenticacion). Cubre los casos en que una liberacion no llego a ejecutarse (la compensacion de
 * una carga que fallo, un corte de Mongo entre dos pasos) y los documentos que quedaron sin contar.
 *
 * Una reserva entra en `cupos` ANTES de crear su documento, asi que un id sin documento puede ser una carga en curso:
 * solo se libera si el id (un ObjectId, que lleva la hora en que se genero) es mas viejo que `minAgeMs`. Todas las
 * escrituras son idempotentes por documento, asi que es seguro con varias replicas.
 */
class QuotaReconciler {
  constructor({ folderRepository, documentRepository, minAgeMs = 10 * 60 * 1000, batchSize = 50, now = () => new Date() }) {
    this.folderRepository = folderRepository;
    this.documentRepository = documentRepository;
    this.minAgeMs = minAgeMs;
    this.batchSize = batchSize;
    this.now = now;
    this._running = false;
    this._timer = null;
  }

  /** Carpetas anteriores a `cupos`: reconstruye su lista desde los documentos. Se llama al arrancar. */
  async migrateLegacy() {
    const migradas = await this.folderRepository.migrateLegacyQuota((ciudadanoId) => this.documentRepository.listNonCertifiedIds(ciudadanoId));
    if (migradas) logger.info("cuota.migracion", { carpetas: migradas });
    return migradas;
  }

  async reconcileOnce() {
    const now = this.now();
    const limite = now.getTime() - this.minAgeMs;
    let liberados = 0;
    let agregados = 0;
    for (const folder of await this.folderRepository.findForQuotaReview(this.batchSize)) {
      const vigentes = new Set(await this.documentRepository.listNonCertifiedIds(folder.ciudadanoId));
      const cupos = new Set(folder.cupos || []);
      const faltantes = [...vigentes].filter((id) => !cupos.has(id));
      const liberables = [...cupos].filter((id) => !vigentes.has(id) && reservadoAntesDe(id, limite));
      await this.folderRepository.reconcileQuota(folder.ciudadanoId, { faltantes, liberables, now });
      liberados += liberables.length;
      agregados += faltantes.length;
    }
    if (liberados || agregados) logger.warn("cuota.reconciliacion", { liberados, agregados });
    return { liberados, agregados };
  }

  start(intervalMs) {
    this.stop();
    this._timer = setInterval(async () => {
      if (this._running) return;
      this._running = true;
      try {
        await this.reconcileOnce();
      } catch (err) {
        logger.error("cuota.reconciliacion_fallo", { err });
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

/** Un id que no es un ObjectId no pudo salir de una reserva de este servicio: se trata como viejo. */
function reservadoAntesDe(id, limiteMs) {
  if (!mongoose.isValidObjectId(id) || String(new mongoose.Types.ObjectId(id)) !== id) return true;
  return new mongoose.Types.ObjectId(id).getTimestamp().getTime() < limiteMs;
}

module.exports = QuotaReconciler;
