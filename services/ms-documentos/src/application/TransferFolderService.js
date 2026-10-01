const logger = require("../tracing/logger");

const EXPORTADA = "transferencia.carpeta_exportada";

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * HU-05c, lado ORIGEN (el ciudadano se va a otro operador). Ordenes que llegan de ms-interoperabilidad:
 *
 *   transferencia.exportar_carpeta -> bloquea la carpeta (solo lectura) y responde con una URL prefirmada y los
 *                                     metadatos de cada documento (`transferencia.carpeta_exportada`)
 *   ciudadano.transferido          -> el destino confirmo: se borran los objetos del storage, los documentos y la carpeta
 *   transferencia.cancelada        -> la transferencia fallo: se desbloquea la carpeta
 *
 * Todas son idempotentes y solo actuan sobre la carpeta que bloqueo ESA transferencia.
 *
 * Se exportan como maximo `maxDocuments` (TRANSFER_MAX_DOCUMENTS, el mismo tope que ms-interoperabilidad y que el
 * cuerpo de 1 MB del protocolo): una carpeta mas grande NO se recorta, la exportacion responde ok:false
 * (`demasiados_documentos`) y la transferencia se cancela con ese motivo.
 */
class TransferFolderService {
  constructor({ folderRepository, documentRepository, storage, eventPublisher, urlTtlSeconds, maxDocuments = 500, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    this.folderRepository = folderRepository;
    this.maxDocuments = maxDocuments;
    this.documentRepository = documentRepository;
    this.storage = storage;
    this.eventPublisher = eventPublisher;
    this.urlTtlSeconds = urlTtlSeconds;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  async export({ transferenciaId, ciudadanoId }) {
    const folder = await this.folderRepository.lockForTransfer(ciudadanoId, transferenciaId);
    if (!folder) {
      logger.warn("transferencia.carpeta_ocupada", { transferenciaId, note: "la carpeta la tiene bloqueada otra transferencia" });
      return this._reply({ transferenciaId, ciudadanoId, ok: false, motivo: "carpeta_en_otra_transferencia" });
    }

    let ids = folder.exportados;
    if (!ids) {
      const todos = await this.documentRepository.listAllByOwner(ciudadanoId, this.maxDocuments + 1);
      if (todos.length > this.maxDocuments) {
        await this.folderRepository.unlock(ciudadanoId, transferenciaId);
        logger.warn("transferencia.carpeta_demasiado_grande", { transferenciaId, maximo: this.maxDocuments });
        return this._reply({ transferenciaId, ciudadanoId, ok: false, motivo: "demasiados_documentos" });
      }
      ids = await this.folderRepository.setExported(ciudadanoId, transferenciaId, todos.map((d) => d._id));
      if (!ids) return this._reply({ transferenciaId, ciudadanoId, ok: false, motivo: "carpeta_en_otra_transferencia" });
    }
    const docs = await this.documentRepository.findByIdsForOwner(ciudadanoId, ids);
    const documentos = [];
    for (const doc of docs) {
      documentos.push({
        documentoId: String(doc._id),
        url: await this.storage.presignedGetUrl(doc.storageKey, this.urlTtlSeconds),
        titulo: doc.titulo,
        entidadAvaladora: doc.entidadAvaladora,
        fecha: iso(doc.fecha),
        // "en autenticacion" no es un estado que el destino pueda recibir: GovCarpeta aun no lo certifico.
        estado: doc.estado === "certificado" ? "certificado" : "temporal",
        fechaAutenticacion: iso(doc.fechaAutenticacion),
        sha256: doc.sha256,
        mimeType: doc.mimeType,
        tamanoBytes: doc.tamanoBytes,
      });
    }
    logger.info("transferencia.carpeta_exportada", { transferenciaId, documentos: documentos.length });
    return this._reply({
      transferenciaId,
      ciudadanoId,
      ok: true,
      documentos,
      urlsVencenEn: new Date(this.now().getTime() + this.urlTtlSeconds * 1000).toISOString(),
    });
  }

  /**
   * El destino confirmo (RF-08): se borra lo que SE EXPORTO. Primero los objetos (si el storage falla, el mensaje se
   * reintenta y nada queda a medias en la base), luego los documentos y al final la carpeta. Repetirlo no hace nada.
   *
   * Si quedo algun documento que no viajo (llego justo mientras se exportaba), NO se borra ni el ni la carpeta: queda
   * bloqueada y se registra para revisarlo a mano. Perder un documento que el destino nunca recibio seria peor.
   */
  async purge({ transferenciaId, ciudadanoId }) {
    const folder = await this.folderRepository.get(ciudadanoId);
    if (!folder || folder.transferenciaId !== transferenciaId) {
      logger.warn("transferencia.borrado_ignorado", { transferenciaId, note: "la carpeta no esta bloqueada por esta transferencia" });
      return { deleted: 0, ignored: true };
    }
    if (!folder.exportados) {
      logger.error("transferencia.borrado_sin_exportacion", { transferenciaId, note: "no hay lista de exportados: no se borra nada" });
      return { deleted: 0, ignored: true };
    }
    const docs = await this.documentRepository.findByIdsForOwner(ciudadanoId, folder.exportados);
    for (const doc of docs) await this.storage.delete(doc.storageKey);
    const deleted = await this.documentRepository.deleteByIds(docs.map((d) => d._id));
    const restantes = await this.documentRepository.listAllByOwner(ciudadanoId, 1);
    if (restantes.length) {
      logger.error("transferencia.documentos_sin_transferir", { transferenciaId, note: "llegaron documentos durante la exportacion; la carpeta se conserva bloqueada" });
    } else {
      await this.folderRepository.deleteForTransfer(ciudadanoId, transferenciaId);
    }
    logger.info("transferencia.carpeta_borrada", { transferenciaId, documentos: deleted });
    return { deleted, ignored: false, conservados: restantes.length > 0 };
  }

  async cancel({ transferenciaId, ciudadanoId }) {
    await this.folderRepository.unlock(ciudadanoId, transferenciaId);
    logger.info("transferencia.carpeta_desbloqueada", { transferenciaId });
  }

  async _reply(payload) {
    // Si el broker no confirma, se lanza: el consumidor reintenta la orden y la exportacion (idempotente) se repite.
    await withTimeout(this.eventPublisher.publish(EXPORTADA, payload), this.eventPublishTimeoutMs);
    return payload;
  }
}

module.exports = { TransferFolderService, EXPORTADA };
