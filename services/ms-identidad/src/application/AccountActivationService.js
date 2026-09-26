const crypto = require("crypto");
const argon2 = require("argon2");
const logger = require("../tracing/logger");

class ActivacionInvalidaError extends Error {
  constructor() {
    // Mismo mensaje para todo: documento inexistente, codigo errado, vencido o cuenta ya activada.
    super("codigo de activacion invalido o vencido");
    this.name = "ActivacionInvalidaError";
  }
}
class ActivacionDatosError extends Error {
  constructor(message) {
    super(message);
    this.name = "ActivacionDatosError";
  }
}

const REQUERIDA = "ciudadano.activacion_requerida";
const MIN_PASSWORD = 8; // misma regla que el registro (HU-01)
const MAX_PASSWORD = 1024;
const CODIGO_RE = /^[A-Za-z0-9_-]{20,100}$/;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function parseDocumento(value) {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Activacion de cuenta del ciudadano que llega TRANSFERIDO desde otro operador (HU-05c): la contrasena no viaja entre
 * operadores, asi que llega sin una y no puede iniciar sesion hasta fijarla aqui.
 *
 *   issue()    genera un codigo aleatorio de un solo uso (256 bits), guarda SOLO su huella SHA-256 y su vencimiento, y
 *              pide a ms-notificaciones que se lo envie al correo que trajo del operador origen
 *   activate() documento + codigo + contrasena nueva -> Argon2id; el codigo se consume en la MISMA escritura condicional
 *              (dos intentos simultaneos con el mismo codigo: solo uno gana)
 *   resend()   codigo nuevo (invalida el anterior), como maximo uno cada `resendCooldownMs`; responde igual exista o no el
 *              documento (no sirve para averiguar quien esta afiliado aqui)
 */
class AccountActivationService {
  constructor({ citizenModel, eventPublisher, auditLogger, ttlMs = 72 * 3600 * 1000, resendCooldownMs = 5 * 60 * 1000, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    this.Citizen = citizenModel;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.ttlMs = ttlMs;
    this.resendCooldownMs = resendCooldownMs;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  /** Genera y envia un codigo para un ciudadano activo SIN contrasena. Devuelve false si no aplica. */
  async issue(citizenId) {
    const codigo = crypto.randomBytes(32).toString("base64url");
    const now = this.now();
    const venceEn = new Date(now.getTime() + this.ttlMs);
    const citizen = await this.Citizen.findOneAndUpdate(
      { _id: citizenId, estado: "activo", passwordHash: null },
      { $set: { activacionHash: sha256(codigo), activacionVenceEn: venceEn, activacionEnviadaEn: now } },
      { new: true }
    ).lean();
    if (!citizen) return false;
    try {
      await withTimeout(
        this.eventPublisher.publish(REQUERIDA, {
          eventId: `${citizen._id}-act-${now.getTime()}`,
          ciudadanoId: String(citizen._id),
          nombre: citizen.nombre,
          correo: citizen.correo,
          codigo, // credencial temporal: solo viaja al servicio de correo (broker interno, TLS fuera de local)
          venceEn: venceEn.toISOString(),
        }),
        this.eventPublishTimeoutMs
      );
    } catch (err) {
      // No se reintenta solo: el ciudadano puede pedir un reenvio (resend) y el codigo guardado sigue sirviendo.
      logger.error("ciudadano.activacion_no_publicada", { note: "el ciudadano puede pedir un reenvio", err });
      return false;
    }
    await this._audit(String(citizen._id), "ciudadano.activacion_enviar", "exito");
    return true;
  }

  async activate(body) {
    const b = body && typeof body === "object" ? body : {};
    const documento = parseDocumento(b.documento);
    if (documento === null) throw new ActivacionDatosError("documento invalido");
    if (typeof b.codigo !== "string" || !CODIGO_RE.test(b.codigo)) throw new ActivacionInvalidaError();
    if (typeof b.password !== "string" || b.password.length < MIN_PASSWORD || b.password.length > MAX_PASSWORD) {
      throw new ActivacionDatosError(`password debe tener entre ${MIN_PASSWORD} y ${MAX_PASSWORD} caracteres`);
    }

    const citizen = await this.Citizen.findOne({ documento }).lean();
    const valido = citizen && citizen.estado === "activo" && citizen.passwordHash === null && citizen.activacionVenceEn && citizen.activacionVenceEn > this.now() && sameHash(sha256(b.codigo), citizen.activacionHash);
    if (!valido) {
      if (citizen) await this._audit(String(citizen._id), "ciudadano.activar", "rechazo", "codigo_invalido_o_vencido");
      throw new ActivacionInvalidaError();
    }

    const passwordHash = await argon2.hash(b.password); // Argon2id (ADR-06)
    // Consumir el codigo y fijar la contrasena en UNA escritura: solo si nadie la fijo entretanto con este mismo codigo.
    const updated = await this.Citizen.findOneAndUpdate(
      { _id: citizen._id, passwordHash: null, activacionHash: citizen.activacionHash },
      { $set: { passwordHash, activacionHash: null, activacionVenceEn: null, intentosFallidos: 0, bloqueadoHasta: null } },
      { new: true }
    ).lean();
    if (!updated) throw new ActivacionInvalidaError();
    await this._audit(String(citizen._id), "ciudadano.activar", "exito");
    logger.info("ciudadano.activado");
    return { activado: true };
  }

  async resend(body) {
    const documento = parseDocumento(body && body.documento);
    if (documento === null) throw new ActivacionDatosError("documento invalido");
    const citizen = await this.Citizen.findOne({ documento }).lean();
    const puede = citizen && citizen.estado === "activo" && citizen.passwordHash === null && (!citizen.activacionEnviadaEn || this.now() - citizen.activacionEnviadaEn >= this.resendCooldownMs);
    if (puede) await this.issue(citizen._id);
    return { mensaje: "si la cuenta esta pendiente de activacion, se envio un codigo nuevo al correo registrado" };
  }

  async _audit(ciudadanoId, action, outcome, reason) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({ actor: ciudadanoId, actorType: "ciudadano", action, resource: `ciudadano:${ciudadanoId}`, resourceOwner: ciudadanoId, outcome, reason });
    } catch (err) {
      logger.error("audit.write_failed", { action, err });
    }
  }
}

module.exports = { AccountActivationService, ActivacionInvalidaError, ActivacionDatosError, REQUERIDA };
