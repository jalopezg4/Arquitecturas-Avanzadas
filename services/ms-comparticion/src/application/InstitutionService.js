const argon2 = require("argon2");
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
/** No existe ninguna entidad con ese NIT: no hay nada que verificar ni revocar (ADR-07). */
class InstitutionNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstitutionNotFoundError";
  }
}
/** La entidad YA estaba en el estado pedido: no se escribio nada (operacion idempotente, ADR-07). */
class AlreadyInStateError extends Error {
  constructor(message, { verificada, verificadaEn, verificadaPor }) {
    super(message);
    this.name = "AlreadyInStateError";
    this.verificada = verificada;
    this.verificadaEn = verificadaEn;
    this.verificadaPor = verificadaPor;
  }
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const PHONE_RE = /^[0-9+()\-\s]{7,20}$/;
// Credencial de la entidad (ADR-07): misma longitud minima que la del ciudadano (HU-01) y un tope que evita usar
// Argon2 como vector de consumo de CPU.
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

/**
 * Los caracteres de control (saltos de linea, tabuladores...) se REEMPLAZAN por un espacio, no se borran: dos palabras
 * separadas por un salto de linea no deben quedar pegadas. Luego se colapsan los espacios. Se filtran por codigo, sin
 * escribir los caracteres de control en una regex.
 */
function clean(value) {
  return [...String(value)].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("").replace(/\s+/g, " ").trim();
}

/**
 * Lo que la operacion de verificacion devuelve de una entidad. Es para la consola del operador (que ya conoce a la
 * entidad, la esta verificando), no para una respuesta HTTP: aun asi no expone la credencial ni la carpeta.
 */
function toPublicView(doc) {
  return {
    institutionId: String(doc._id),
    nombre: doc.nombre,
    tipo: doc.tipo,
    nit: doc.nit,
    verificada: doc.verificada === true,
    verificadaEn: doc.verificadaEn || null,
    verificadaPor: doc.verificadaPor || null,
    motivoVerificacion: doc.motivoVerificacion || null,
  };
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

    // Credencial OPCIONAL (ADR-07). Opcional, no obligatoria, por dos razones: el contrato de HU-06.1 ya esta
    // mergeado (responde exactamente {institutionId}) y la entidad puede registrarse hoy sin querer autenticarse
    // todavia. Una entidad sin contrasena simplemente NO puede autenticarse (ver EntityAuthService).
    let password = null;
    if (data.password !== undefined && data.password !== null && data.password !== "") {
      if (typeof data.password !== "string" || data.password.length < MIN_PASSWORD_LENGTH || data.password.length > MAX_PASSWORD_LENGTH) {
        problems.push(`password debe ser una cadena de ${MIN_PASSWORD_LENGTH} a ${MAX_PASSWORD_LENGTH} caracteres`);
      } else password = data.password;
    }

    if (problems.length) throw new ValidationError(problems);
    return { nombre, tipo, nit: nit.nit, nitDv: nit.dv, correoContacto, telefono, direccion, password };
  }

  /**
   * Registra la entidad y le asigna su carpeta institucional propia, en una sola escritura.
   * @returns {{institutionId: string}}
   */
  async register(input) {
    const { password, ...data } = this._validate(input); // los datos invalidos no se auditan: aun no hay un actor identificable
    // Argon2id (ADR-06), la misma politica que la contrasena del ciudadano. Nunca se guarda ni se registra en claro.
    const passwordHash = password ? await argon2.hash(password) : null;
    try {
      const institution = await this.institutionRepository.create({ ...data, passwordHash, verificada: false, carpeta: { id: crypto.randomUUID(), estado: "activa", creadaEn: this.now() } });
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
   * ADR-07: verifica o revoca la verificacion de una entidad. Es una decision HUMANA del operador tomada fuera de
   * banda (no hay fuente externa que consultar: GovCarpeta no conoce instituciones y no hay API del RUES/DIAN en el
   * alcance), y lo unico que hace el sistema es REGISTRARLA con su fecha, su responsable y su motivo.
   *
   * No existe ninguna ruta HTTP que llegue aqui a proposito: la unica interfaz es `scripts/verify-institution.js`,
   * que exige acceso al despliegue. Asi una entidad no puede verificarse a si misma.
   *
   * Pasos: validar argumentos -> localizar por NIT -> comprobar que existe -> cambio CONDICIONAL (idempotente)
   * -> guardar estado + fecha + responsable + motivo -> auditar como `sistema`.
   *
   * @param {{nit: string, decididaPor: string, motivo: string}} input
   * @param {{dryRun?: boolean}} options  dryRun: valida y consulta, pero NO escribe nada
   * @returns {{status: "dry-run"|"aplicada", verificada: boolean, institucion: object}}
   * @throws {ValidationError} argumentos invalidos (nada consultado ni escrito)
   * @throws {InstitutionNotFoundError} no hay entidad con ese NIT
   * @throws {AlreadyInStateError} ya estaba en ese estado: no se escribio nada
   */
  async setVerification({ nit, decididaPor, motivo } = {}, { verificada, dryRun = false } = {}) {
    const clean = this._validateVerification({ nit, decididaPor, motivo }, { verificada, dryRun });
    const accion = verificada ? "institucion.verificar" : "institucion.revocar_verificacion";

    const current = await this.institutionRepository.findByNit(clean.nit);
    if (!current) {
      await this._auditVerification(accion, clean, "fallo", "nit_no_registrado");
      throw new InstitutionNotFoundError(`No hay ninguna institucion registrada con el NIT ${clean.nit}. No se cambio nada.`);
    }
    if (current.verificada === verificada) {
      await this._auditVerification(accion, clean, "rechazo", "sin_cambios", current._id);
      throw new AlreadyInStateError(
        `La institucion ya estaba ${verificada ? "verificada" : "sin verificar"} (desde ${current.verificadaEn ? current.verificadaEn.toISOString() : "el registro"}). No se cambio nada.`,
        current
      );
    }

    if (dryRun) {
      return { status: "dry-run", verificada, institucion: toPublicView(current) };
    }

    const result = await this.institutionRepository.setVerification(clean.nit, {
      verificada,
      decididaEn: this.now(),
      decididaPor: clean.decididaPor,
      motivo: clean.motivo,
    });
    // Otra ejecucion simultanea pudo adelantarse entre la lectura y la escritura: se trata igual que el caso de arriba.
    if (result.status !== "aplicada") {
      await this._auditVerification(accion, clean, "rechazo", "sin_cambios", current._id);
      throw new AlreadyInStateError(`La institucion ya estaba ${verificada ? "verificada" : "sin verificar"} (cambio simultaneo). No se cambio nada.`, result.institution || current);
    }

    await this._auditVerification(accion, clean, "exito", undefined, result.institution._id);
    logger.info("institucion.verificacion_cambiada", { verificada }); // sin NIT ni nombre
    return { status: "aplicada", verificada, institucion: toPublicView(result.institution) };
  }

  /** Azucar sobre setVerification: deja explicito en quien llama que esta verificando o revocando. */
  verify(input, options = {}) {
    return this.setVerification(input, { ...options, verificada: true });
  }

  revokeVerification(input, options = {}) {
    return this.setVerification(input, { ...options, verificada: false });
  }

  _validateVerification({ nit, decididaPor, motivo }, { verificada, dryRun }) {
    const problems = [];
    if (typeof verificada !== "boolean") problems.push("verificada debe indicarse (usa verify() o revokeVerification())");

    const parsed = parseNit(nit);
    if (!parsed.ok) problems.push(parsed.reason);

    const responsable = typeof decididaPor === "string" ? clean(decididaPor) : "";
    // El responsable es obligatorio SIEMPRE: una decision sin responsable no es trazable, y en simulacion sirve
    // para que quien la ejecuta vea exactamente lo que quedaria escrito.
    if (responsable.length < 2 || responsable.length > 120) problems.push("decididaPor es obligatorio (2 a 120 caracteres): quien toma la decision");

    const razon = typeof motivo === "string" ? clean(motivo) : "";
    // El motivo es la EVIDENCIA de la revision. En simulacion se permite omitirlo (todavia no se escribe nada).
    if (!dryRun && (razon.length < 5 || razon.length > 500)) problems.push("motivo es obligatorio (5 a 500 caracteres): en que se baso la decision");
    else if (razon.length > 500) problems.push("motivo no puede superar 500 caracteres");

    if (problems.length) throw new ValidationError(problems);
    return { nit: parsed.ok ? parsed.nit : "", decididaPor: responsable, motivo: razon || null };
  }

  /** Bitacora de la decision: el actor es el OPERADOR actuando como sistema, no la entidad (ADR-07). */
  async _auditVerification(action, { nit, decididaPor, motivo }, outcome, reason, institutionId) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({
        actor: decididaPor,
        // "sistema": la decision la toma el operador fuera de banda, no la entidad ni un ciudadano.
        actorType: "sistema",
        action,
        resource: institutionId ? `institucion:${institutionId}` : `nit:${nit}`,
        resourceOwner: String(nit),
        outcome,
        reason,
        metadata: motivo ? { motivo } : undefined,
      });
    } catch (err) {
      logger.error("audit.write_failed", { action, err });
    }
  }

  /**
   * HU-06.2 (entrega de paquetes): true si la entidad con ese NIT tiene carpeta institucional (entrega INTERNA al
   * ecosistema); false si no (entonces se usa el envio por correo, RF-26). Un NIT invalido o inexistente es simplemente
   * "no tiene carpeta", no un error: quien entrega debe poder caer al correo.
   *
   * NOTA PARA EL EQUIPO (HU-06.2, otro integrante): esta funcion NO mira `verificada`, y se deja asi a proposito.
   * Con ADR-07 una entidad puede existir con carpeta activa y NO estar verificada; habra que decidir si, para
   * entregar un paquete documental, una entidad sin verificar "tiene carpeta" (entrega interna) o debe caer al
   * envio por correo (RF-26). Es una decision de HU-06.2, no de la verificacion.
   */
  async hasInstitutionalFolder({ nit } = {}) {
    const parsed = parseNit(nit);
    if (!parsed.ok) return false;
    const institution = await this.institutionRepository.findByNit(parsed.nit);
    return Boolean(institution && institution.carpeta && institution.carpeta.estado === "activa");
  }
}

module.exports = { InstitutionService, ValidationError, ConflictError, InstitutionNotFoundError, AlreadyInStateError, toPublicView };
