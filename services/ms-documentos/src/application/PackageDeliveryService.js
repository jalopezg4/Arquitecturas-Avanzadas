const mongoose = require("mongoose");
const logger = require("../tracing/logger");
const PackageGrant = require("../domain/PackageGrant");
const { DocumentoNoEncontradoError } = require("../domain/errors");

const PROCESADO = "paquete.procesado";
const ENVIO_CORREO = "paquete.envio_correo";

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * HU-06.2 en ms-documentos (dueno de los archivos y de quien puede leerlos).
 *
 *   deliver()          `paquete.creado` (de ms-comparticion): comprueba que TODOS los documentos existan y sean del
 *                      ciudadano; luego, segun el canal:
 *                        carpeta_institucional -> registra el permiso de lectura para la entidad (RF-25)
 *                        correo                -> firma una URL temporal por documento y pide a ms-notificaciones el
 *                                                 envio (`paquete.envio_correo`, RF-26)
 *                      y responde `paquete.procesado` {ok, documentos (metadatos), remitenteDireccionUnica}
 *   entityDownload()   la entidad descarga un documento de un paquete que le entregaron (URL de 15 minutos)
 *
 * No se duplica ningun archivo: el permiso y el correo apuntan a los mismos objetos del storage.
 */
class PackageDeliveryService {
  constructor({ documentRepository, folderRepository, storage, eventPublisher, auditLogger, emailUrlTtlSeconds = 3600, entityUrlTtlSeconds = 900, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    this.documentRepository = documentRepository;
    this.folderRepository = folderRepository;
    this.storage = storage;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.emailUrlTtlSeconds = emailUrlTtlSeconds;
    this.entityUrlTtlSeconds = entityUrlTtlSeconds;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  async _publish(routingKey, payload) {
    await withTimeout(this.eventPublisher.publish(routingKey, payload), this.eventPublishTimeoutMs);
  }

  async deliver({ paqueteId, ciudadanoId, documentoIds, canal, institutionId, correoDestino, nombreDestino }) {
    const docs = [];
    for (const id of documentoIds) {
      const doc = mongoose.isValidObjectId(id) ? await this.documentRepository.findById(id) : null;
      // Inexistente o ajeno se reportan igual: el paquete no revela que documentos tiene otro ciudadano.
      if (!doc || doc.ciudadanoId !== ciudadanoId) {
        await this._audit(ciudadanoId, paqueteId, canal, "rechazo", "documento_no_es_del_ciudadano");
        await this._publish(PROCESADO, { paqueteId, ok: false, motivo: "uno o mas documentos no existen o no son del ciudadano" });
        return { ok: false };
      }
      docs.push(doc);
    }
    const folder = await this.folderRepository.get(ciudadanoId);
    const remitenteDireccionUnica = (folder && folder.direccionUnica) || null;
    const metadatos = docs.map((d) => ({ documentoId: String(d._id), titulo: d.titulo, entidadAvaladora: d.entidadAvaladora, fecha: d.fecha, mimeType: d.mimeType }));

    if (canal === "carpeta_institucional") {
      // Idempotente: una reentrega de la orden no crea otro permiso.
      await PackageGrant.updateOne({ paqueteId }, { $setOnInsert: { paqueteId, institutionId, ciudadanoId, documentoIds: metadatos.map((m) => m.documentoId) } }, { upsert: true });
    } else {
      const documentos = [];
      for (const d of docs) documentos.push({ titulo: d.titulo, url: await this.storage.presignedGetUrl(d.storageKey, this.emailUrlTtlSeconds) });
      // eventId = paqueteId: una reentrega es el MISMO correo para ms-notificaciones (se envia una sola vez).
      await this._publish(ENVIO_CORREO, {
        eventId: paqueteId,
        paqueteId,
        ciudadanoId,
        correo: correoDestino,
        nombreDestino: nombreDestino || null,
        remitenteDireccionUnica,
        documentos,
        vencenEn: new Date(this.now().getTime() + this.emailUrlTtlSeconds * 1000).toISOString(),
      });
    }

    await this._audit(ciudadanoId, paqueteId, canal, "exito", undefined, { documentos: docs.length, institutionId: institutionId || undefined });
    await this._publish(PROCESADO, { paqueteId, ok: true, documentos: metadatos, remitenteDireccionUnica });
    logger.info("paquete.entregado", { paqueteId, canal, documentos: docs.length });
    return { ok: true };
  }

  /**
   * RF-25: la entidad descarga un documento de un paquete entregado en SU carpeta. 404 en todo caso de no-acceso
   * (paquete de otra entidad, documento fuera del paquete, documento borrado o ya no del ciudadano): no se revela nada.
   */
  async entityDownload({ institutionId, paqueteId, documentoId }) {
    const grant = typeof paqueteId === "string" && paqueteId.length <= 64 ? await PackageGrant.findOne({ paqueteId, institutionId }).lean() : null;
    if (!grant || !grant.documentoIds.includes(documentoId)) throw new DocumentoNoEncontradoError();
    const doc = mongoose.isValidObjectId(documentoId) ? await this.documentRepository.findById(documentoId) : null;
    if (!doc || doc.ciudadanoId !== grant.ciudadanoId) throw new DocumentoNoEncontradoError();
    const downloadUrl = await this.storage.presignedGetUrl(doc.storageKey, this.entityUrlTtlSeconds);
    if (this.auditLogger) {
      await this.auditLogger
        .record({ actor: institutionId, actorType: "entidad", action: "documento.descargar", resource: `documento:${documentoId}`, resourceOwner: grant.ciudadanoId, delegated: true, outcome: "exito", metadata: { paqueteId } })
        .catch((err) => logger.error("audit.write_failed", { action: "documento.descargar", err }));
    }
    return { documentoId, titulo: doc.titulo, mimeType: doc.mimeType, downloadUrl, expiraEn: new Date(this.now().getTime() + this.entityUrlTtlSeconds * 1000).toISOString() };
  }

  async _audit(ciudadanoId, paqueteId, canal, outcome, reason, metadata) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({ actor: "ms-comparticion", actorType: "sistema", action: "documento.compartir", resource: `paquete:${paqueteId}`, resourceOwner: ciudadanoId, delegated: true, outcome, reason, metadata: { canal, ...(metadata || {}) } });
    } catch (err) {
      logger.error("audit.write_failed", { action: "documento.compartir", err });
    }
  }
}

module.exports = { PackageDeliveryService, PROCESADO, ENVIO_CORREO };
