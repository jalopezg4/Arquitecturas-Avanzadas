const mongoose = require("mongoose");
const logger = require("../tracing/logger");
const OfficialRequest = require("../domain/OfficialRequest");
const { parseNit } = require("../domain/nit");
const { CarpetaEnTransferenciaError, DocumentoNoEncontradoError, DocumentoAjenoError } = require("../domain/errors");

class SolicitudOficialInvalidaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SolicitudOficialInvalidaError";
  }
}
class SolicitudOficialDuplicadaError extends Error {
  constructor() {
    super("ya hay una solicitud abierta del documento oficial para este documento");
    this.name = "SolicitudOficialDuplicadaError";
  }
}
class SolicitudOficialNoAtendibleError extends Error {
  constructor() {
    super("la solicitud del documento oficial no existe, no es de esta entidad o ya fue atendida");
    this.name = "SolicitudOficialNoAtendibleError";
  }
}

const CREADA = "solicitud_oficial.creada";
const PENDIENTE = "solicitud_oficial.pendiente";
// Un solo destinatario (sin comas ni punto y coma): el transporte trataria "a@x.co,b@y.co" como dos.
const SINGLE_EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const MAX_DESCRIPCION = 500;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function citizenView(r) {
  return {
    solicitudOficialId: String(r._id),
    documentoTemporalId: r.documentoTemporalId,
    tituloDocumento: r.tituloDocumento,
    nit: r.nit,
    entidad: r.nombreEntidad || undefined,
    descripcion: r.descripcion || undefined,
    estado: r.estado,
    documentoDefinitivoId: r.documentoDefinitivoId || undefined,
    creadaEn: r.createdAt,
    atendidaEn: r.atendidaEn || undefined,
  };
}

/**
 * HU-06.4 (RF-31): solicitud del documento OFICIAL a la entidad emisora, para reemplazar un documento temporal.
 *
 *   create()         el ciudadano la pide sobre un documento temporal propio -> `solicitud_oficial.creada`
 *                    (ms-comparticion, duena de las entidades, dice a que institucion corresponde el NIT)
 *   onResolved()     -> `pendiente` (la entidad la vera en su bandeja) o `sin_entidad` (no esta afiliada aqui)
 *   listForEntity()  bandeja de la entidad: pendientes con la direccion unica del ciudadano (para entregar por HU-10)
 *   assertAttendable() / complete()  la entrega de HU-10 que indica la solicitud la atiende y REEMPLAZA el temporal
 */
class OfficialRequestService {
  constructor({ documentRepository, folderRepository, storage, eventPublisher, auditLogger, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    this.documentRepository = documentRepository;
    this.folderRepository = folderRepository;
    this.storage = storage;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  async create({ ciudadanoId, documentoId, body }) {
    if (typeof documentoId !== "string" || !mongoose.isValidObjectId(documentoId)) throw new DocumentoNoEncontradoError();
    const doc = await this.documentRepository.findById(documentoId);
    if (!doc) throw new DocumentoNoEncontradoError();
    if (doc.ciudadanoId !== ciudadanoId) {
      await this._audit({ actor: ciudadanoId, actorType: "ciudadano", action: "documento.solicitar_oficial", documentoId, owner: doc.ciudadanoId, outcome: "rechazo", reason: "no_es_dueno" });
      throw new DocumentoAjenoError("solo el dueno del documento puede solicitar su version oficial");
    }
    if (doc.estado !== "temporal") throw new SolicitudOficialInvalidaError("solo se puede pedir el documento oficial de un documento temporal");
    const folder = await this.folderRepository.get(ciudadanoId);
    if (folder && folder.transferenciaId) throw new CarpetaEnTransferenciaError();

    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const parsed = parseNit(b.nit);
    if (!parsed.ok) throw new SolicitudOficialInvalidaError("nit de la entidad emisora invalido");
    let descripcion = null;
    if (b.descripcion !== undefined && b.descripcion !== null && b.descripcion !== "") {
      if (typeof b.descripcion !== "string" || b.descripcion.length > MAX_DESCRIPCION) throw new SolicitudOficialInvalidaError(`descripcion debe ser un texto de hasta ${MAX_DESCRIPCION} caracteres`);
      descripcion = b.descripcion.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    }

    let request;
    try {
      request = (await OfficialRequest.create({ ciudadanoId, documentoTemporalId: documentoId, tituloDocumento: doc.titulo, nit: parsed.nit, descripcion })).toObject();
    } catch (err) {
      if (err && err.code === 11000) throw new SolicitudOficialDuplicadaError();
      throw err;
    }
    await this._audit({ actor: ciudadanoId, actorType: "ciudadano", action: "documento.solicitar_oficial", documentoId, owner: ciudadanoId, outcome: "exito" });
    await this.publish(request).catch(() => {});
    return citizenView(request);
  }

  /** Pide a ms-comparticion que resuelva el NIT. Si el broker no confirma, lo reenvia el reconciliador. */
  async publish(request) {
    try {
      await withTimeout(this.eventPublisher.publish(CREADA, { solicitudOficialId: String(request._id), nit: request.nit }), this.eventPublishTimeoutMs);
      await OfficialRequest.updateOne({ _id: request._id }, { eventoPublicado: true });
    } catch (err) {
      logger.error("solicitud_oficial.evento_no_publicado", { solicitudOficialId: String(request._id), note: "la reenvia el reconciliador", err });
      throw err;
    }
  }

  async findUnpublished({ olderThan, limit }) {
    return OfficialRequest.find({ estado: "resolviendo", eventoPublicado: false, createdAt: { $lte: olderThan } }).sort({ createdAt: 1 }).limit(limit).lean();
  }

  async onResolved({ solicitudOficialId, institutionId, nombre, correoContacto }) {
    const correo = typeof correoContacto === "string" && correoContacto.length <= 200 && SINGLE_EMAIL_RE.test(correoContacto) ? correoContacto : null;
    const set = institutionId
      ? { estado: "pendiente", institutionId, nombreEntidad: nombre || null, correoEntidad: correo, avisoPublicado: !correo }
      : { estado: "sin_entidad", abierta: false };
    const updated = await OfficialRequest.findOneAndUpdate({ _id: solicitudOficialId, estado: "resolviendo" }, { $set: set }, { new: true }).lean();
    if (!updated) return { applied: false };
    logger.info("solicitud_oficial.resuelta", { solicitudOficialId, estado: updated.estado });
    if (updated.estado === "pendiente" && updated.correoEntidad) await this.notifyEntity(updated).catch(() => {});
    return { applied: true };
  }

  /**
   * Aviso por correo a la entidad: tiene una solicitud nueva en su bandeja. `eventId` = solicitud, asi un reenvio es el
   * mismo correo. Si el broker no confirma queda `avisoPublicado:false` y lo reenvia el reconciliador.
   */
  async notifyEntity(r) {
    const folder = await this.folderRepository.get(r.ciudadanoId);
    try {
      await withTimeout(
        this.eventPublisher.publish(PENDIENTE, {
          eventId: String(r._id),
          solicitudOficialId: String(r._id),
          ciudadanoId: r.ciudadanoId,
          correo: r.correoEntidad,
          nombreEntidad: r.nombreEntidad || null,
          tituloDocumento: r.tituloDocumento,
          descripcion: r.descripcion || null,
          remitenteDireccionUnica: (folder && folder.direccionUnica) || null,
        }),
        this.eventPublishTimeoutMs
      );
      await OfficialRequest.updateOne({ _id: r._id }, { avisoPublicado: true });
    } catch (err) {
      logger.error("solicitud_oficial.aviso_no_publicado", { solicitudOficialId: String(r._id), note: "lo reenvia el reconciliador", err });
      throw err;
    }
  }

  async findPendingNotices({ olderThan, limit }) {
    return OfficialRequest.find({ estado: "pendiente", avisoPublicado: false, updatedAt: { $lte: olderThan } }).sort({ updatedAt: 1 }).limit(limit).lean();
  }

  async listMine(ciudadanoId) {
    const items = await OfficialRequest.find({ ciudadanoId }).sort({ createdAt: -1 }).limit(200).lean();
    return { solicitudes: items.map(citizenView) };
  }

  /** Bandeja de la entidad: SOLO las pendientes dirigidas a ella, con lo que necesita para entregar por HU-10. */
  async listForEntity(institutionId) {
    const items = await OfficialRequest.find({ institutionId, estado: "pendiente" }).sort({ createdAt: 1 }).limit(200).lean();
    const out = [];
    for (const r of items) {
      const folder = await this.folderRepository.get(r.ciudadanoId);
      out.push({ solicitudOficialId: String(r._id), destinatario: (folder && folder.direccionUnica) || null, tituloDocumento: r.tituloDocumento, descripcion: r.descripcion || undefined, creadaEn: r.createdAt });
    }
    return { solicitudes: out };
  }

  /**
   * Antes de aceptar una entrega de HU-10 que dice atender una solicitud: debe existir, estar pendiente, ser de ESTA
   * entidad y del MISMO ciudadano al que va el documento. Si no, la entrega se rechaza entera (409) sin guardar nada.
   */
  async assertAttendable({ solicitudOficialId, institutionId, ciudadanoId, documentoDefinitivoId = null }) {
    const r = typeof solicitudOficialId === "string" && mongoose.isValidObjectId(solicitudOficialId) ? await OfficialRequest.findById(solicitudOficialId).lean() : null;
    if (!r || r.institutionId !== institutionId || r.ciudadanoId !== ciudadanoId) throw new SolicitudOficialNoAtendibleError();
    if (r.estado === "pendiente") return r;
    // Reintento de un envio que YA atendio esta misma solicitud: se acepta (idempotente), pero solo con ese documento.
    if (documentoDefinitivoId && r.estado === "atendida" && r.documentoDefinitivoId === documentoDefinitivoId) return r;
    throw new SolicitudOficialNoAtendibleError();
  }

  /**
   * El definitivo ya se guardo: la solicitud queda atendida (una sola vez) y el temporal se REEMPLAZA -- se borran sus
   * metadatos, se libera su cupo (RNF-04) y se borra su archivo, si sigue siendo temporal y del ciudadano.
   *
   * Si un intento anterior marco la solicitud pero se corto antes de terminar, el reintento del MISMO envio (mismo
   * documento definitivo) retoma la limpieza: cada paso es idempotente.
   */
  async complete({ solicitudOficialId, documentoDefinitivoId, institutionId, ciudadanoId }) {
    // El filtro repite la entidad y el ciudadano (defensa en profundidad): ninguna entrega cierra una solicitud ajena,
    // aunque el llamador se haya saltado `assertAttendable`.
    const r = await OfficialRequest.findOneAndUpdate(
      { _id: solicitudOficialId, estado: "pendiente", institutionId, ciudadanoId },
      { $set: { estado: "atendida", abierta: false, documentoDefinitivoId, atendidaEn: this.now() } },
      { new: true }
    ).lean();
    if (!r) return this._resumeCompletion({ solicitudOficialId, documentoDefinitivoId, institutionId, ciudadanoId });
    const replaced = await this._replaceTemporal(r);
    await this._audit({ actor: institutionId, actorType: "entidad", action: "documento.reemplazar_temporal", documentoId: r.documentoTemporalId, owner: r.ciudadanoId, delegated: true, outcome: "exito", metadata: { solicitudOficialId, documentoDefinitivoId, temporalReemplazado: replaced } });
    logger.info("solicitud_oficial.atendida", { solicitudOficialId, temporalReemplazado: replaced });
    return { replaced };
  }

  /** Reintento de un `complete` que se corto: solo si ESTA entrega (mismo definitivo) ya habia atendido la solicitud. */
  async _resumeCompletion({ solicitudOficialId, documentoDefinitivoId, institutionId, ciudadanoId }) {
    const r = await OfficialRequest.findOne({ _id: solicitudOficialId, estado: "atendida", institutionId, ciudadanoId, documentoDefinitivoId }).lean();
    if (!r) return { replaced: false };
    const replaced = await this._replaceTemporal(r);
    if (replaced) logger.info("solicitud_oficial.reemplazo_retomado", { solicitudOficialId });
    return { replaced };
  }

  /**
   * Orden pensado para los reintentos: primero los metadatos (el documento deja de existir para el ciudadano), luego
   * el cupo (idempotente por documento, se repite siempre) y al final el archivo. Si el archivo no se puede borrar
   * queda huerfano en el storage, pero nunca un documento que apunta a un archivo inexistente.
   */
  async _replaceTemporal(r) {
    const temporal = await this.documentRepository.findById(r.documentoTemporalId);
    let replaced = false;
    if (temporal && temporal.ciudadanoId === r.ciudadanoId && temporal.estado === "temporal") {
      replaced = (await this.documentRepository.deleteByIds([temporal._id])) > 0;
      if (replaced) await this.storage.delete(temporal.storageKey).catch((err) => logger.error("solicitud_oficial.temporal_no_borrado_del_storage", { err }));
    }
    await this.folderRepository.releaseNonCertified(r.ciudadanoId, r.documentoTemporalId);
    return replaced;
  }

  async _audit({ actor, actorType, action, documentoId, owner, delegated = false, outcome, reason, metadata }) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({ actor: String(actor), actorType, action, resource: `documento:${documentoId}`, resourceOwner: String(owner), delegated, outcome, reason, metadata });
    } catch (err) {
      logger.error("audit.write_failed", { action, err });
    }
  }
}

module.exports = { OfficialRequestService, SolicitudOficialInvalidaError, SolicitudOficialDuplicadaError, SolicitudOficialNoAtendibleError, CREADA, PENDIENTE };
