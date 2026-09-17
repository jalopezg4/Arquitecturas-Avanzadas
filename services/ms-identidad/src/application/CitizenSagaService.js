const argon2 = require("argon2");
const crypto = require("crypto");

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

/**
 * HU-01: Registro de un ciudadano, implementado como saga orquestada (ADR-04).
 * Pasos: valida -> persiste PENDIENTE -> valida en GovCarpeta -> registra en GovCarpeta
 * -> marca ACTIVO -> publica evento. Si falla despues de confirmar en GovCarpeta,
 * compensa con unregisterCitizen (el ciudadano NO debe quedar huerfano).
 */
class CitizenSagaService {
  constructor({ citizenRepository, govCarpetaClient, eventPublisher }) {
    this.citizenRepository = citizenRepository;
    this.govCarpetaClient = govCarpetaClient;
    this.eventPublisher = eventPublisher;
  }

  _validateInput({ documento, nombre, direccion, correo, password }) {
    if (!documento || !nombre || !direccion || !correo || !password) {
      throw new ValidationError("documento, nombre, direccion, correo y password son requeridos");
    }
    if (!EMAIL_RE.test(correo)) {
      throw new ValidationError("correo invalido");
    }
  }

  _buildDireccionUnica(documento) {
    return `${documento}-${crypto.randomBytes(4).toString("hex")}@carpetacolombia.co`;
  }

  async register({ documento, nombre, direccion, correo, password }) {
    this._validateInput({ documento, nombre, direccion, correo, password });

    const existing = await this.citizenRepository.findByDocumento(documento);
    if (existing) {
      throw new ConflictError("El documento ya esta registrado");
    }

    // Paso 1: validar disponibilidad en GovCarpeta ANTES de persistir nada
    let validation;
    try {
      validation = await this.govCarpetaClient.validateCitizen(documento);
    } catch (err) {
      throw new ServiceUnavailableError("GovCarpeta no disponible");
    }
    if (!validation.available) {
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
      passwordHash,
      direccionUnica,
      estado: "pendiente",
    });

    // Paso 3: confirmar en GovCarpeta
    try {
      await this.govCarpetaClient.registerCitizen({
        id: documento,
        name: nombre,
        address: direccion,
        email: correo,
      });
    } catch (err) {
      // No se pudo confirmar: el ciudadano se queda pendiente (no huerfano, no activo).
      // No hace falta compensacion porque GovCarpeta nunca lo acepto.
      throw new ServiceUnavailableError("No fue posible completar el registro en GovCarpeta");
    }

    // Paso 4: marcar activo (solo tras 201 de GovCarpeta)
    let activeCitizen;
    try {
      activeCitizen = await this.citizenRepository.markActive(citizen._id);
    } catch (err) {
      // Fallo DESPUES de que GovCarpeta ya confirmo: aqui si se necesita compensacion.
      await this.govCarpetaClient.unregisterCitizen(documento).catch(() => {
        /* best-effort; queda para reconciliacion/alerta a soporte */
      });
      throw err;
    }

    // Paso 5: publicar evento SOLO si el estado final es activo
    await this.eventPublisher.publish("ciudadano.registrado", {
      ciudadanoId: activeCitizen._id.toString(),
      documento: activeCitizen.documento,
      direccionUnica: activeCitizen.direccionUnica,
    });

    return { ciudadanoId: activeCitizen._id.toString(), direccionUnica: activeCitizen.direccionUnica };
  }
}

module.exports = { CitizenSagaService, ValidationError, ConflictError, ServiceUnavailableError };
