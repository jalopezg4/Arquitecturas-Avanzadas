const crypto = require("crypto");
const logger = require("../tracing/logger");
const { documentoCargadoPayload } = require("./events");
const { ESTADOS } = require("../domain/Document");

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}
class UnsupportedMediaTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedMediaTypeError";
  }
}
class PayloadTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}
class QuotaExceededError extends Error {
  constructor(limit) {
    super(`Cuota de documentos no certificados alcanzada (maximo ${limit}). Certifica o elimina documentos temporales para cargar otro.`);
    this.name = "QuotaExceededError";
    this.limit = limit;
  }
}
class StorageUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

const PDF_MAGIC = "%PDF-";
const MAX_TEXT = 200;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

/** Entero positivo estricto ("2" si, "2.5", "1e3", "-1", "0", "abc" no). Ausente -> valor por defecto. */
function parsePositiveInt(value, fallback, field) {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" && typeof value !== "number") throw new ValidationError(`${field} debe ser un entero positivo`);
  const text = String(value);
  if (!/^\d{1,9}$/.test(text) || Number(text) < 1) throw new ValidationError(`${field} debe ser un entero positivo`);
  return Number(text);
}

/** Lo que el ciudadano ve de cada documento; la clave del storage y la huella son internas y no se exponen. */
function toListItem(doc) {
  return {
    documentoId: String(doc._id),
    titulo: doc.titulo,
    estado: doc.estado,
    entidadAvaladora: doc.entidadAvaladora,
    fecha: doc.fecha,
    fechaCarga: doc.createdAt,
    mimeType: doc.mimeType,
    tamanoBytes: doc.tamanoBytes,
  };
}

/** Espera `promise` como maximo `ms`. Si tarda mas, rechaza (la promesa original se ignora). */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cleanText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${field} es requerido`);
  const text = value.trim();
  if (text.length > MAX_TEXT) throw new ValidationError(`${field} no puede superar ${MAX_TEXT} caracteres`);
  return text;
}

function parseFecha(value, now) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError("fecha es requerida");
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) throw new ValidationError("fecha debe ser una fecha valida (ej. 2026-03-15)");
  const date = new Date(ms);
  if (date.getUTCFullYear() < 1900) throw new ValidationError("fecha no es plausible");
  if (ms > now.getTime() + 24 * 3600 * 1000) throw new ValidationError("fecha no puede estar en el futuro");
  return date;
}

/**
 * HU-03: carga de un documento a la carpeta del ciudadano.
 *
 * Orden deliberado (cada paso falla sin dejar basura):
 *   1. validar archivo y metadatos             -> 400 / 413 / 415, sin tocar nada
 *   2. reservar cupo de cuota (ATOMICO)        -> 409 si esta llena, SIN haber subido el archivo
 *   3. subir al object storage                 -> si falla, se devuelve el cupo (503)
 *   4. guardar metadatos (solo la clave)       -> si falla, se borra el objeto y se devuelve el cupo
 *   5. publicar DocumentoCargado               -> si falla NO falla la carga (ADR-04): queda marcado para reconciliar
 *
 * La cuota aplica SOLO a documentos `temporal` (RNF-04); los `certificado` (p. ej. recibidos de una entidad
 * emisora, HU-10) no la consumen. La carga temporal por documento faltante (RF-30) usa este mismo metodo: solo
 * agrega `solicitudId` a los metadatos.
 */
class DocumentService {
  constructor({ documentRepository, folderRepository, storage, eventPublisher, auditLogger, quota, maxUploadBytes, downloadTtlSeconds, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    this.documentRepository = documentRepository;
    this.folderRepository = folderRepository;
    this.storage = storage;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.quota = quota;
    this.maxUploadBytes = maxUploadBytes;
    this.downloadTtlSeconds = downloadTtlSeconds;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  async _audit(ciudadanoId, outcome, reason, metadata, documentoId) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({
        actor: String(ciudadanoId),
        actorType: "ciudadano",
        action: "documento.cargar",
        resource: documentoId ? `documento:${documentoId}` : `carpeta:${ciudadanoId}`,
        resourceOwner: String(ciudadanoId),
        outcome,
        reason,
        metadata,
      });
    } catch (auditErr) {
      // Un fallo de la bitacora se reporta pero no tumba una carga ya completada.
      logger.error("audit.write_failed", { action: "documento.cargar", err: auditErr });
    }
  }

  _validate({ ciudadanoId, file, metadata, estado }) {
    if (typeof ciudadanoId !== "string" || !ciudadanoId) throw new ValidationError("ciudadanoId es requerido");
    if (!ESTADOS.includes(estado)) throw new ValidationError(`estado debe ser uno de ${ESTADOS.join(", ")}`);

    if (!file || !Buffer.isBuffer(file.buffer)) throw new ValidationError("archivo es requerido");
    if (file.buffer.length === 0) throw new ValidationError("el archivo esta vacio");
    if (file.buffer.length > this.maxUploadBytes) throw new PayloadTooLargeError(`el archivo supera el maximo de ${this.maxUploadBytes} bytes`);
    // El tipo que declara el cliente no es confiable: se exige tambien la firma real del PDF.
    if (file.mimetype !== "application/pdf") throw new UnsupportedMediaTypeError("solo se aceptan archivos PDF");
    if (file.buffer.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) throw new UnsupportedMediaTypeError("el archivo no es un PDF valido");

    const meta = metadata || {};
    const clean = {
      titulo: cleanText(meta.titulo, "titulo"),
      entidadAvaladora: cleanText(meta.entidadAvaladora, "entidadAvaladora"),
      fecha: parseFecha(meta.fecha, this.now()),
      solicitudId: null,
    };
    if (meta.solicitudId !== undefined && meta.solicitudId !== null && meta.solicitudId !== "") {
      if (typeof meta.solicitudId !== "string" || !ID_RE.test(meta.solicitudId)) throw new ValidationError("solicitudId invalido");
      clean.solicitudId = meta.solicitudId;
    }
    return clean;
  }

  /**
   * @param {object} input
   * @param {string} input.ciudadanoId  dueno de la carpeta (ya verificado contra el token por quien llama)
   * @param {{buffer: Buffer, mimetype: string}} input.file
   * @param {{titulo: string, entidadAvaladora: string, fecha: string, solicitudId?: string}} input.metadata
   * @param {"temporal"|"certificado"} [input.estado]
   * @returns {Promise<{documentoId: string, url: string}>}
   */
  async upload({ ciudadanoId, file, metadata, estado = "temporal" }) {
    // Datos invalidos no se auditan como intento (no hay nada que reconstruir); el resto de fallos si.
    const clean = this._validate({ ciudadanoId, file, metadata, estado });

    const consumesQuota = estado === "temporal";
    let reserved = false;
    let key = null;
    let stored = false;
    try {
      if (consumesQuota) {
        reserved = await this.folderRepository.reserveNonCertified(ciudadanoId, this.quota);
        if (!reserved) throw new QuotaExceededError(this.quota);
      }

      key = this.storage.newKey(ciudadanoId);
      // La URL se firma localmente y solo depende de la clave: se calcula ANTES de guardar nada, asi ningun paso
      // posterior a crear el documento puede fallar y dejar una compensacion a medias.
      const url = await this.storage.presignedGetUrl(key, this.downloadTtlSeconds);
      try {
        await this.storage.put(key, file.buffer, file.mimetype);
        stored = true;
      } catch (err) {
        logger.error("documento.storage_fallo", { step: "put", err });
        throw new StorageUnavailableError("El almacenamiento de documentos no esta disponible");
      }

      const doc = await this.documentRepository.create({
        ciudadanoId,
        ...clean,
        estado,
        storageKey: key,
        mimeType: file.mimetype,
        tamanoBytes: file.buffer.length,
        sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
      });

      await this._publish(doc);
      await this._audit(ciudadanoId, "exito", undefined, { estado, tamanoBytes: file.buffer.length }, doc._id.toString());
      return { documentoId: doc._id.toString(), url };
    } catch (err) {
      // Compensacion: no dejar cupo reservado ni un objeto huerfano si la carga no se completo.
      if (stored) {
        await this.storage.delete(key).catch((e) => logger.error("documento.compensacion_fallo", { step: "delete_objeto", err: e }));
      }
      if (reserved) {
        await this.folderRepository.releaseNonCertified(ciudadanoId).catch((e) => logger.error("documento.compensacion_fallo", { step: "liberar_cupo", err: e }));
      }
      const reason = err instanceof QuotaExceededError ? "cuota_llena" : err.message;
      await this._audit(ciudadanoId, err instanceof QuotaExceededError ? "rechazo" : "fallo", reason);
      throw err;
    }
  }

  /** Publica DocumentoCargado. Si el broker no responde a tiempo o rechaza, la carga NO falla: queda `eventoPublicado:false`. */
  /**
   * HU-08: documentos de la carpeta de UN ciudadano, paginados (RF-19, RF-20). El dueno lo verifica la ruta
   * (requireOwner) y ademas la consulta filtra por ciudadanoId, asi que nunca devuelve documentos ajenos.
   * page >= 1 (por defecto 1); pageSize 1..MAX_PAGE_SIZE (por defecto 10, un valor mayor se limita a MAX_PAGE_SIZE).
   * Una carpeta vacia o una pagina fuera de rango NO es un error: devuelve documentos:[] con el total real.
   */
  async list({ ciudadanoId, page, pageSize }) {
    if (typeof ciudadanoId !== "string" || !ciudadanoId) throw new ValidationError("ciudadanoId es requerido");
    const currentPage = parsePositiveInt(page, DEFAULT_PAGE, "page");
    const size = Math.min(parsePositiveInt(pageSize, DEFAULT_PAGE_SIZE, "pageSize"), MAX_PAGE_SIZE);
    const { items, total } = await this.documentRepository.listByOwner(ciudadanoId, { skip: (currentPage - 1) * size, limit: size });
    return {
      documentos: items.map(toListItem),
      total,
      currentPage,
      pageSize: size,
      totalPages: Math.ceil(total / size),
    };
  }

  async _publish(doc) {
    const payload = documentoCargadoPayload(doc); // mismo mensaje que reenvia EventReconciler si esta publicacion falla
    try {
      await withTimeout(this.eventPublisher.publish("documento.cargado", payload), this.eventPublishTimeoutMs);
      await this.documentRepository.markEventPublished(doc._id);
    } catch (err) {
      logger.error("documento.evento_no_publicado", { documentoId: payload.documentoId, note: "lo reenvia EventReconciler", err });
    }
  }
}

module.exports = { DocumentService, ValidationError, UnsupportedMediaTypeError, PayloadTooLargeError, QuotaExceededError, StorageUnavailableError };
