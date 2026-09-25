const logger = require("../tracing/logger");
const { TIPOS, ESTADOS } = require("../domain/PqrsCase");

/** Datos invalidos: lleva TODOS los problemas a la vez. */
class ValidationError extends Error {
  constructor(problems) {
    super(problems.join("; "));
    this.name = "ValidationError";
    this.problems = problems;
  }
}
/**
 * No existe ningun caso con ese id PARA ESTA institucion. Se usa tanto si el id no existe como si pertenece a
 * OTRA institucion: no se distingue (404 en ambos casos), para no confirmarle a una institucion que un caso
 * ajeno existe (mismo principio que `DestinatarioNoEncontradoError` en ms-documentos/HU-10).
 */
class CaseNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaseNotFoundError";
  }
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const MAX_SUBJECT_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

/** Entero positivo estricto ("2" si, "2.5", "-1", "0", "abc" no). Ausente -> valor por defecto. */
function parsePositiveInt(value, fallback, field) {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" && typeof value !== "number") throw new ValidationError([`${field} debe ser un entero positivo`]);
  const text = String(value);
  if (!/^\d{1,9}$/.test(text) || Number(text) < 1) throw new ValidationError([`${field} debe ser un entero positivo`]);
  return Number(text);
}

function toView(doc) {
  return {
    id: String(doc._id),
    institutionId: doc.institutionId,
    type: doc.type,
    subject: doc.subject,
    description: doc.description,
    status: doc.status,
    documentId: doc.documentId || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * HU-07.2: gestion de casos PQRS de una institucion. Autocontenido (sin llamar a otros microservicios): la
 * asociacion opcional a `documentId` es una referencia de solo texto, no se verifica contra ms-documentos.
 *
 * Institucion autenticada != institucion Premium: la restriccion de que solo instituciones con plan Premium
 * puedan usar este servicio NO esta implementada (es deliberado, no un olvido -- ver docs/SEGURIDAD.md,
 * seccion 12.2). Por ahora, cualquier institucion con una identidad institucional valida (ADR-07) puede crear y
 * gestionar sus propios casos.
 */
class PqrsCaseService {
  constructor({ pqrsCaseRepository, auditLogger, now = () => new Date() }) {
    this.pqrsCaseRepository = pqrsCaseRepository;
    this.auditLogger = auditLogger;
    this.now = now;
  }

  async _audit({ institutionId, action, resource, outcome, reason, metadata }) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({ actor: institutionId, actorType: "entidad", action, resource, resourceOwner: institutionId, outcome, reason, metadata });
    } catch (err) {
      logger.error("audit.write_failed", { action, err });
    }
  }

  /** documentId, si viene, debe tener forma de ObjectId de Mongo (el formato que usa ms-documentos); no se verifica que exista. */
  _parseDocumentId(documentId, problems) {
    if (documentId === undefined || documentId === null || documentId === "") return null;
    if (typeof documentId !== "string" || !OBJECT_ID_RE.test(documentId)) {
      problems.push("documentId no tiene un formato valido");
      return null;
    }
    return documentId;
  }

  async create({ institutionId, type, subject, description, documentId }) {
    const problems = [];
    if (!TIPOS.includes(type)) problems.push(`type debe ser uno de ${TIPOS.join(", ")}`);

    const cleanSubject = typeof subject === "string" ? subject.trim() : "";
    if (!cleanSubject) problems.push("subject es requerido");
    else if (cleanSubject.length > MAX_SUBJECT_LENGTH) problems.push(`subject no puede superar ${MAX_SUBJECT_LENGTH} caracteres`);

    const cleanDescription = typeof description === "string" ? description.trim() : "";
    if (!cleanDescription) problems.push("description es requerida");
    else if (cleanDescription.length > MAX_DESCRIPTION_LENGTH) problems.push(`description no puede superar ${MAX_DESCRIPTION_LENGTH} caracteres`);

    const cleanDocumentId = this._parseDocumentId(documentId, problems);

    if (problems.length) throw new ValidationError(problems);

    const created = await this.pqrsCaseRepository.create({
      institutionId,
      type,
      subject: cleanSubject,
      description: cleanDescription,
      documentId: cleanDocumentId,
      status: "abierto",
    });
    await this._audit({ institutionId, action: "pqrs.crear", resource: `pqrs:${created._id}`, outcome: "exito" });
    return toView(created);
  }

  /** Solo devuelve casos de `institutionId`; nunca de otra institucion (RNF-07). */
  async list({ institutionId, page, pageSize }) {
    const currentPage = parsePositiveInt(page, DEFAULT_PAGE, "page");
    const size = Math.min(parsePositiveInt(pageSize, DEFAULT_PAGE_SIZE, "pageSize"), MAX_PAGE_SIZE);
    const { items, total } = await this.pqrsCaseRepository.listByInstitution(institutionId, { skip: (currentPage - 1) * size, limit: size });
    return { casos: items.map(toView), total, currentPage, pageSize: size, totalPages: Math.ceil(total / size) };
  }

  /** 404 (no 403) tanto si el id no existe como si pertenece a otra institucion: ver CaseNotFoundError. */
  async get({ institutionId, caseId }) {
    if (!OBJECT_ID_RE.test(caseId || "")) throw new ValidationError(["id no tiene un formato valido"]);
    const found = await this.pqrsCaseRepository.findById(caseId);
    if (!found || found.institutionId !== institutionId) throw new CaseNotFoundError("caso no encontrado");
    return toView(found);
  }

  async updateStatus({ institutionId, caseId, status }) {
    if (!ESTADOS.includes(status)) throw new ValidationError([`status debe ser uno de ${ESTADOS.join(", ")}`]);
    if (!OBJECT_ID_RE.test(caseId || "")) throw new ValidationError(["id no tiene un formato valido"]);

    const existing = await this.pqrsCaseRepository.findById(caseId);
    if (!existing || existing.institutionId !== institutionId) throw new CaseNotFoundError("caso no encontrado");

    const updated = await this.pqrsCaseRepository.updateStatus(caseId, status);
    await this._audit({
      institutionId,
      action: "pqrs.cambiar_estado",
      resource: `pqrs:${caseId}`,
      outcome: "exito",
      metadata: { from: existing.status, to: status },
    });
    return toView(updated);
  }
}

module.exports = { PqrsCaseService, ValidationError, CaseNotFoundError };
