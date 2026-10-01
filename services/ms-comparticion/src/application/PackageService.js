const logger = require("../tracing/logger");

class PackageValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageValidationError";
  }
}
class PackageNotFoundError extends Error {
  constructor() {
    super("paquete no encontrado");
    this.name = "PackageNotFoundError";
  }
}
class EntidadNoVerificadaError extends Error {
  constructor() {
    super("la entidad no esta verificada por el operador");
    this.name = "EntidadNoVerificadaError";
  }
}

const CREADO = "paquete.creado";
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
// Un solo destinatario: sin comas, punto y coma ni espacios (el transporte de correo trataria "a@x.co,b@y.co" como dos).
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function paging(page, pageSize) {
  const p = page === undefined ? 1 : Number(page);
  const s = pageSize === undefined ? DEFAULT_PAGE_SIZE : Number(pageSize);
  if (!Number.isInteger(p) || p < 1 || !/^\d{1,9}$/.test(String(page ?? 1))) throw new PackageValidationError("page debe ser un entero positivo");
  if (!Number.isInteger(s) || s < 1 || !/^\d{1,9}$/.test(String(pageSize ?? DEFAULT_PAGE_SIZE))) throw new PackageValidationError("pageSize debe ser un entero positivo");
  const size = Math.min(s, MAX_PAGE_SIZE);
  return { currentPage: p, pageSize: size, skip: (p - 1) * size };
}

const clean = (v, max) => String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, max);

/** Lo que ve el ciudadano de un paquete suyo (el destinatario lo eligio el mismo). Sin claves ni URLs. */
function citizenView(p) {
  return {
    paqueteId: String(p._id),
    canal: p.canal,
    estado: p.estado,
    motivo: p.motivo || undefined,
    destino: p.canal === "carpeta_institucional" ? { tipo: "institucion", nombre: p.nombreDestino } : { tipo: "correo", correo: p.correoDestino, nombre: p.nombreDestino || undefined },
    documentos: p.estado === "entregado" ? p.documentos : p.documentoIds.map((documentoId) => ({ documentoId })),
    creadoEn: p.createdAt,
    entregadoEn: p.entregadoEn || undefined,
  };
}

/** Lo que ve la entidad: quien lo envio (por su direccion unica) y los metadatos. Nunca claves ni ids internos del ciudadano. */
function institutionView(p) {
  return { paqueteId: String(p._id), remitente: p.remitenteDireccionUnica, documentos: p.documentos, entregadoEn: p.entregadoEn };
}

/**
 * HU-06.2 (RF-24/25/26): paquetes documentales.
 *
 *   create()        el ciudadano elige documentos y destinatario -> se decide el canal y se publica `paquete.creado`
 *                   (ms-documentos comprueba que los documentos sean suyos y concede el acceso o envia el correo)
 *   onProcessed()   respuesta de ms-documentos -> `entregado` (con metadatos) o `rechazado`
 *   listMine()      paquetes del ciudadano
 *   listReceived()  paquetes entregados en la carpeta de una entidad (solo si SIGUE verificada)
 */
class PackageService {
  constructor({ packageRepository, institutionService, eventPublisher, auditLogger, maxDocumentos = 20, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    this.packages = packageRepository;
    this.institutions = institutionService;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.maxDocumentos = maxDocumentos;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  _parse(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new PackageValidationError("el cuerpo debe ser un objeto");
    const ids = body.documentoIds;
    if (!Array.isArray(ids) || ids.length === 0) throw new PackageValidationError("documentoIds debe ser una lista con al menos un documento");
    if (!ids.every((id) => typeof id === "string" && OBJECT_ID_RE.test(id))) throw new PackageValidationError("documentoIds contiene un id invalido");
    const documentoIds = [...new Set(ids.map((id) => id.toLowerCase()))]; // referencias, sin repetidos
    if (documentoIds.length > this.maxDocumentos) throw new PackageValidationError(`un paquete admite maximo ${this.maxDocumentos} documentos`);

    const dest = body.destinatario;
    if (!dest || typeof dest !== "object" || Array.isArray(dest)) throw new PackageValidationError("destinatario es requerido: {nit} y/o {correo, nombre}");
    const nit = dest.nit === undefined || dest.nit === null || dest.nit === "" ? null : dest.nit;
    if (nit !== null && typeof nit !== "string") throw new PackageValidationError("nit invalido");
    let correo = null;
    if (dest.correo !== undefined && dest.correo !== null && dest.correo !== "") {
      if (typeof dest.correo !== "string" || dest.correo.length > 200 || !EMAIL_RE.test(dest.correo.trim())) throw new PackageValidationError("correo invalido (un solo destinatario)");
      correo = dest.correo.trim().toLowerCase();
    }
    const nombre = typeof dest.nombre === "string" && dest.nombre.trim() ? clean(dest.nombre, 150) : null;
    if (!nit && !correo) throw new PackageValidationError("destinatario debe tener nit o correo");
    return { documentoIds, nit, correo, nombre };
  }

  async create({ ciudadanoId, body }) {
    const req = this._parse(body);
    const target = req.nit ? await this.institutions.resolveDeliveryTarget({ nit: req.nit }) : { canal: "correo", registrada: false };

    let data;
    if (target.canal === "carpeta_institucional") {
      data = { canal: target.canal, institutionId: target.institutionId, nombreDestino: target.nombre };
    } else {
      // RF-26. Entidad registrada (sin verificar): su correo de contacto. No registrada: el que indique el ciudadano.
      const correo = target.registrada ? target.correo : req.correo;
      if (!correo) throw new PackageValidationError("la entidad no esta afiliada a ningun operador: indica un correo para enviarle el paquete");
      data = { canal: "correo", correoDestino: correo, nombreDestino: target.nombre || req.nombre };
    }

    const pkg = await this.packages.create({ ciudadanoId, documentoIds: req.documentoIds, ...data });
    await this._audit(ciudadanoId, pkg, "paquete.crear", "exito");
    await this.publish(pkg).catch(() => {});
    return citizenView(pkg);
  }

  /** Publica la orden; si el broker no confirma, queda `eventoPublicado:false` y la reenvia el reconciliador. */
  async publish(pkg) {
    const payload = {
      paqueteId: String(pkg._id),
      ciudadanoId: pkg.ciudadanoId,
      documentoIds: pkg.documentoIds,
      canal: pkg.canal,
      institutionId: pkg.institutionId || null,
      correoDestino: pkg.correoDestino || null,
      nombreDestino: pkg.nombreDestino || null,
    };
    try {
      await withTimeout(this.eventPublisher.publish(CREADO, payload), this.eventPublishTimeoutMs);
      await this.packages.markEventPublished(pkg._id);
    } catch (err) {
      logger.error("paquete.evento_no_publicado", { paqueteId: payload.paqueteId, note: "lo reenvia el reconciliador", err });
      throw err;
    }
  }

  async onProcessed({ paqueteId, ok, motivo, documentos, remitenteDireccionUnica }) {
    const set = ok
      ? {
          estado: "entregado",
          entregadoEn: this.now(),
          documentos: (documentos || []).map((d) => ({ documentoId: d.documentoId, titulo: d.titulo, entidadAvaladora: d.entidadAvaladora, fecha: d.fecha, mimeType: d.mimeType })),
          remitenteDireccionUnica: remitenteDireccionUnica || null,
        }
      : { estado: "rechazado", motivo: motivo || "rechazado" };
    const pkg = await this.packages.resolve(paqueteId, set);
    if (!pkg) return { ignored: true };
    await this._audit(pkg.ciudadanoId, pkg, "paquete.entregar", ok ? "exito" : "fallo", ok ? undefined : set.motivo);
    logger.info("paquete.procesado", { paqueteId, estado: pkg.estado, canal: pkg.canal });
    return { estado: pkg.estado };
  }

  async listMine({ ciudadanoId, page, pageSize }) {
    const pg = paging(page, pageSize);
    const { items, total } = await this.packages.listByCitizen(ciudadanoId, pg);
    return { paquetes: items.map(citizenView), total, currentPage: pg.currentPage, pageSize: pg.pageSize, totalPages: Math.ceil(total / pg.pageSize) };
  }

  async getMine({ ciudadanoId, paqueteId }) {
    const pkg = OBJECT_ID_RE.test(paqueteId || "") ? await this.packages.findById(paqueteId) : null;
    if (!pkg || pkg.ciudadanoId !== ciudadanoId) throw new PackageNotFoundError(); // ajeno = inexistente
    return citizenView(pkg);
  }

  async listReceived({ institutionId, page, pageSize }) {
    // Se lee la verificacion de la base PROPIA: una revocacion surte efecto de inmediato aqui (el token puede seguir vivo).
    if (!(await this.institutions.isVerified(institutionId))) throw new EntidadNoVerificadaError();
    const pg = paging(page, pageSize);
    const { items, total } = await this.packages.listDeliveredTo(institutionId, pg);
    return { paquetes: items.map(institutionView), total, currentPage: pg.currentPage, pageSize: pg.pageSize, totalPages: Math.ceil(total / pg.pageSize) };
  }

  async _audit(ciudadanoId, pkg, action, outcome, reason) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({
        actor: action === "paquete.crear" ? ciudadanoId : "ms-comparticion",
        actorType: action === "paquete.crear" ? "ciudadano" : "sistema",
        action,
        resource: `paquete:${pkg._id}`,
        resourceOwner: ciudadanoId,
        delegated: action !== "paquete.crear",
        outcome,
        reason,
        metadata: { canal: pkg.canal, documentos: pkg.documentoIds.length, institutionId: pkg.institutionId || undefined },
      });
    } catch (err) {
      logger.error("audit.write_failed", { action, err });
    }
  }
}

module.exports = { PackageService, PackageValidationError, PackageNotFoundError, EntidadNoVerificadaError, CREADO, citizenView };
