const crypto = require("crypto");
const logger = require("../tracing/logger");
const { TIPOS } = require("../domain/Institution");
const { parseNit } = require("../domain/nit");
const { DuplicateInstitutionError } = require("../infrastructure/InstitutionRepository");

/** Datos invalidos: lleva TODOS los problemas a la vez. */
class ValidationError extends Error {
  constructor(problems) {
    super(problems.join("; "));
    this.name = "ValidationError";
    this.problems = problems;
  }
}
class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
  }
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const PHONE_RE = /^[0-9+()\-\s]{7,20}$/;

/**
 * Los caracteres de control (saltos de linea, tabuladores...) se REEMPLAZAN por un espacio, no se borran: dos palabras
 * separadas por un salto de linea no deben quedar pegadas. Luego se colapsan los espacios. Se filtran por codigo, sin
 * escribir los caracteres de control en una regex.
 */
function clean(value) {
  return [...String(value)].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("").replace(/\s+/g, " ").trim();
}

/**
 * HU-06.1: registro de una entidad institucional (RF-37) y su carpeta institucional.
 *
 * El registro es AUTODECLARADO (cualquiera puede llamarlo, salvo que se configure REGISTRATION_TOKEN): nadie verifica
 * que la entidad sea quien dice. Por eso el NIT es unico y se valida con su digito de verificacion, todo queda en la
 * bitacora y cada entidad nace con `verificada: false`. Ver docs/SEGURIDAD.md.
 */
class InstitutionService {
  constructor({ institutionRepository, auditLogger, now = () => new Date() }) {
    this.institutionRepository = institutionRepository;
    this.auditLogger = auditLogger;
    this.now = now;
  }

  async _audit(nit, outcome, reason, institutionId) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({
        actor: String(nit),
        actorType: "entidad",
        action: "institucion.registrar",
        resource: institutionId ? `institucion:${institutionId}` : `nit:${nit}`,
        resourceOwner: String(nit),
        outcome,
        reason,
      });
    } catch (err) {
      logger.error("audit.write_failed", { action: "institucion.registrar", err });
    }
  }

  _validate(input) {
    const problems = [];
    const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};

    const nombre = typeof data.nombre === "string" ? clean(data.nombre) : "";
    if (nombre.length < 3 || nombre.length > 200) problems.push("nombre es obligatorio (3 a 200 caracteres)");

    const tipo = typeof data.tipo === "string" ? data.tipo.trim().toLowerCase() : "";
    if (!TIPOS.includes(tipo)) problems.push(`tipo debe ser uno de: ${TIPOS.join(", ")}`);

    const nit = parseNit(data.nit);
    if (!nit.ok) problems.push(nit.reason);

    const correoContacto = typeof data.correoContacto === "string" ? data.correoContacto.trim().toLowerCase() : "";
    if (!correoContacto || correoContacto.length > 200 || !EMAIL_RE.test(correoContacto)) problems.push("correoContacto debe ser un correo valido");

    let telefono = null;
    if (data.telefono !== undefined && data.telefono !== null && data.telefono !== "") {
      if (typeof data.telefono !== "string" || !PHONE_RE.test(data.telefono.trim())) problems.push("telefono no es valido");
      else telefono = data.telefono.trim();
    }
    let direccion = null;
    if (data.direccion !== undefined && data.direccion !== null && data.direccion !== "") {
      const d = typeof data.direccion === "string" ? clean(data.direccion) : "";
      if (!d || d.length > 200) problems.push("direccion no es valida (maximo 200 caracteres)");
      else direccion = d;
    }

    if (problems.length) throw new ValidationError(problems);
    return { nombre, tipo, nit: nit.nit, nitDv: nit.dv, correoContacto, telefono, direccion };
  }

  /**
   * Registra la entidad y le asigna su carpeta institucional propia, en una sola escritura.
   * @returns {{institutionId: string}}
   */
  async register(input) {
    const data = this._validate(input); // los datos invalidos no se auditan: aun no hay un actor identificable
    try {
      const institution = await this.institutionRepository.create({ ...data, verificada: false, carpeta: { id: crypto.randomUUID(), estado: "activa", creadaEn: this.now() } });
      await this._audit(data.nit, "exito", undefined, institution._id.toString());
      return { institutionId: institution._id.toString() };
    } catch (err) {
      if (err instanceof DuplicateInstitutionError) {
        await this._audit(data.nit, "rechazo", "nit_duplicado");
        throw new ConflictError(err.message);
      }
      await this._audit(data.nit, "fallo", err.message);
      throw err;
    }
  }

  /**
   * HU-06.2 (entrega de paquetes): true si la entidad con ese NIT tiene carpeta institucional (entrega INTERNA al
   * ecosistema); false si no (entonces se usa el envio por correo, RF-26). Un NIT invalido o inexistente es simplemente
   * "no tiene carpeta", no un error: quien entrega debe poder caer al correo.
   */
  async hasInstitutionalFolder({ nit } = {}) {
    const parsed = parseNit(nit);
    if (!parsed.ok) return false;
    const institution = await this.institutionRepository.findByNit(parsed.nit);
    return Boolean(institution && institution.carpeta && institution.carpeta.estado === "activa");
  }
}

module.exports = { InstitutionService, ValidationError, ConflictError };
