const argon2 = require("argon2");
const crypto = require("crypto");
const { publishCitizenRegistered } = require("./events");
const logger = require("../tracing/logger");

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}
class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
  }
}
class ServiceUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Mismo criterio que PHONE_RE en ms-comparticion (InstitutionService.js): copia propia a proposito, ningun
// microservicio importa codigo de otro.
const PHONE_RE = /^[0-9+()\-\s]{7,20}$/;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isValidTelefono(v) {
  return typeof v === "string" && PHONE_RE.test(v);
}

function isValidDocumento(v) {
  // GovCarpeta espera `id` como number (ver docs/GOVCARPETA_CONTRATO.md), asi que
  // documento debe ser o ya un number, o una cadena que representa un entero positivo.
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n > 0 && String(v).trim() === String(n);
}

/**
 * HU-01: Registro de un ciudadano, implementado como saga orquestada (ADR-04).
 * Pasos: valida -> persiste PENDIENTE -> valida en GovCarpeta -> registra en GovCarpeta
 * -> marca ACTIVO -> publica evento. Si falla despues de confirmar en GovCarpeta,
 * compensa con unregisterCitizen (el ciudadano NO debe quedar huerfano).
 */
/** GovCarpeta respondio y dijo que no (4xx o 501). Sin respuesta, o un 5xx que no es 501, es ambiguo. */
function isDefinitiveRejection(err) {
  const status = err && err.response && err.response.status;
  return Number.isInteger(status) && ((status >= 400 && status < 500) || status === 501);
}

class CitizenSagaService {
  constructor({ citizenRepository, govCarpetaClient, eventPublisher, auditLogger, eventPublishTimeoutMs }) {
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.citizenRepository = citizenRepository;
    this.govCarpetaClient = govCarpetaClient;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
  }

  _validateInput({ documento, nombre, direccion, correo, password, telefono }) {
    if (documento === undefined || documento === null || !nombre || !direccion || !correo || !password) {
      throw new ValidationError("documento, nombre, direccion, correo y password son requeridos");
    }
    if (!isValidDocumento(documento)) {
      throw new ValidationError("documento debe ser un numero entero positivo");
    }
    if (!isNonEmptyString(nombre)) {
      throw new ValidationError("nombre debe ser una cadena no vacia");
    }
    if (!isNonEmptyString(direccion)) {
      throw new ValidationError("direccion debe ser una cadena no vacia");
    }
    if (!isNonEmptyString(correo) || !EMAIL_RE.test(correo)) {
      throw new ValidationError("correo invalido");
    }
    if (!isNonEmptyString(password) || password.length < 8) {
      throw new ValidationError("password debe tener al menos 8 caracteres");
    }
    // Opcional: ausente o null es valido (HU-06.3, RF-28). Si viene, debe ser un string con formato de telefono --
    // ni objetos, ni arrays, ni numeros: `typeof v === "string"` en isValidTelefono descarta todo eso.
    if (telefono !== undefined && telefono !== null && !isValidTelefono(telefono)) {
      throw new ValidationError("telefono invalido");
    }
  }

  _buildDireccionUnica(documento) {
    return `${documento}-${crypto.randomBytes(4).toString("hex")}@carpetacolombia.co`;
  }

  /**
   * Registra en la bitacora (HT-04). Es best-effort: un fallo de auditoria no debe tumbar un
   * registro ya confirmado en GovCarpeta, se reporta para reconciliacion.
   */
  async _audit(documento, outcome, reason) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({
        actor: String(documento),
        actorType: "ciudadano",
        action: "ciudadano.registrar",
        resource: `ciudadano:${documento}`,
        resourceOwner: String(documento),
        outcome,
        reason,
      });
    } catch (auditErr) {
      logger.error("audit.write_failed", { action: "ciudadano.registrar", err: auditErr });
    }
  }

  async register({ documento, nombre, direccion, correo, password, telefono }) {
    this._validateInput({ documento, nombre, direccion, correo, password, telefono });
    // Normaliza a Number una vez validado -- GovCarpeta y el esquema de Mongo esperan number.
    documento = Number(documento);

    // Los errores de validacion no se auditan: aun no hay un actor identificable.
    try {
      const result = await this._runSaga({ documento, nombre, direccion, correo, password, telefono });
      await this._audit(documento, "exito");
      return result;
    } catch (err) {
      await this._audit(documento, err instanceof ConflictError ? "rechazo" : "fallo", err.message);
      throw err;
    }
  }

  async _runSaga({ documento, nombre, direccion, correo, password, telefono }) {
    logger.info("saga.registro.inicio");
    const existing = await this.citizenRepository.findByDocumento(documento);
    if (existing) {
      logger.warn("saga.registro.rechazado", { step: "documento_local", reason: "ya_registrado" });
      throw new ConflictError("El documento ya esta registrado");
    }

    // Paso 1: validar disponibilidad en GovCarpeta ANTES de persistir nada
    let validation;
    try {
      validation = await this.govCarpetaClient.validateCitizen(documento);
    } catch (err) {
      logger.error("saga.paso_fallido", { step: "govcarpeta.validateCitizen", err });
      throw new ServiceUnavailableError("GovCarpeta no disponible");
    }
    if (!validation.available) {
      logger.warn("saga.registro.rechazado", { step: "govcarpeta.validateCitizen", reason: "ya_afiliado" });
      throw new ConflictError("El ciudadano ya esta afiliado a otro operador");
    }

    // Paso 2: persistir en estado PENDIENTE antes de llamar a registerCitizen
    const passwordHash = await argon2.hash(password);
    const direccionUnica = this._buildDireccionUnica(documento);
    const citizen = await this.citizenRepository.create({
      documento,
      nombre,
      direccion,
      correo,
      telefono: telefono || null, // ausente o "" -> null explicito, igual que el default del esquema
      passwordHash,
      direccionUnica,
      estado: "pendiente",
    });
    logger.info("saga.paso_ok", { step: "persistir_pendiente", ciudadanoId: citizen._id.toString() });

    // Paso 3: confirmar en GovCarpeta
    try {
      await this.govCarpetaClient.registerCitizen({
        id: documento,
        name: nombre,
        address: direccion,
        email: correo,
      });
    } catch (err) {
      logger.error("saga.paso_fallido", { step: "govcarpeta.registerCitizen", err });
      // Rechazo DEFINITIVO (GovCarpeta respondio 4xx/501): no lo acepto, asi que no queda nada que reconciliar y se
      // borra el pendiente; si no, el documento quedaria bloqueado (409 "ya registrado") sin poder corregir los datos.
      // Ante un fallo AMBIGUO (timeout, 5xx distinto de 501) se conserva el pendiente: GovCarpeta pudo haber aceptado.
      if (isDefinitiveRejection(err)) {
        await this.citizenRepository.deletePending(citizen._id).catch((delErr) => logger.error("saga.limpieza_fallida", { err: delErr }));
      }
      throw new ServiceUnavailableError("No fue posible completar el registro en GovCarpeta");
    }

    // Paso 4: marcar activo (solo tras 201 de GovCarpeta)
    let activeCitizen;
    try {
      activeCitizen = await this.citizenRepository.markActive(citizen._id);
      logger.info("saga.paso_ok", { step: "marcar_activo" });
    } catch (err) {
      logger.error("saga.paso_fallido", { step: "marcar_activo", err });
      logger.warn("saga.compensacion", { step: "govcarpeta.unregisterCitizen" });
      // Fallo DESPUES de que GovCarpeta ya confirmo: aqui si se necesita compensacion.
      await this.govCarpetaClient.unregisterCitizen(documento).catch(() => {
        /* best-effort; queda para reconciliacion/alerta a soporte */
      });
      throw err;
    }

    // Paso 5: publicar evento SOLO si el estado final es activo. El ciudadano ya quedo
    // activo y confirmado en GovCarpeta en este punto -- un fallo de RabbitMQ (broker caido,
    // nack) no debe hacer fallar el registro (ADR-04: la notificacion no es camino critico).
    // Se registra el fallo para reconciliacion/alerta a soporte en vez de propagar el error.
    if (await publishCitizenRegistered(this.eventPublisher, activeCitizen, { timeoutMs: this.eventPublishTimeoutMs })) {
      await this.citizenRepository.markEventPublished(activeCitizen._id).catch((err) => logger.error("saga.marca_evento_fallo", { err }));
    } // si no, queda eventoPublicado:false y PendingRegistrationReconciler lo reenvia

    logger.info("saga.registro.completo", { ciudadanoId: activeCitizen._id.toString() });
    return { ciudadanoId: activeCitizen._id.toString(), direccionUnica: activeCitizen.direccionUnica };
  }
}

module.exports = { CitizenSagaService, ValidationError, ConflictError, ServiceUnavailableError };
