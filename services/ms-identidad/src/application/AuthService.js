const argon2 = require("argon2");
const crypto = require("crypto");
const logger = require("../tracing/logger");
const { parseDuration } = require("../config/ConfigValidator");
const { ValidationError } = require("./CitizenSagaService");

const ISSUER = "ms-identidad";
const MAX_PASSWORD_LENGTH = 1024; // evita usar Argon2 como vector de consumo de CPU/memoria con entradas enormes

/** Refresh token invalido, expirado, ya usado o de una cuenta que ya no puede iniciar sesion: siempre el mismo mensaje. */
class InvalidTokenError extends Error {
  constructor() {
    super("token invalido o expirado");
    this.name = "InvalidTokenError";
  }
}

/** Unico error de credenciales: mismo mensaje para documento inexistente, password mala, cuenta bloqueada o no activa. */
class InvalidCredentialsError extends Error {
  constructor() {
    super("credenciales invalidas");
    this.name = "InvalidCredentialsError";
  }
}

function isValidDocumento(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n > 0 && String(v).trim() === String(n);
}

// Resumen Argon2id de un valor descartable: cuando el documento no existe se verifica contra el igual,
// para que "no existe" y "password incorrecta" tarden lo mismo y no se pueda enumerar ciudadanos por tiempo.
let dummyHashPromise;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = argon2.hash(crypto.randomBytes(16).toString("hex"));
  return dummyHashPromise;
}

/**
 * HU-02: autenticacion del ciudadano (100% local: no involucra a GovCarpeta ni a la Registraduria).
 *
 * - Verifica el password contra el resumen Argon2id guardado.
 * - Emite access token (15 min) y refresh token (mayor vigencia), firmados con el llavero de HT-07.
 * - Cuenta intentos fallidos por ciudadano y bloquea temporalmente al alcanzar `maxAttempts`.
 * - Registra cada intento en la bitacora (HT-04).
 * - refresh(): canjea un refresh token por un par nuevo; cada refresh token vale UNA sola vez (rotacion) y si se
 *   presenta uno ya usado se revocan todos los del ciudadano (deteccion de robo).
 * - Toda causa de rechazo devuelve el MISMO error: no se revela si el documento existe ni si esta bloqueado.
 */
class AuthService {
  constructor({
    citizenRepository,
    refreshTokenRepository,
    secrets,
    auditLogger,
    accessExpiresIn = "15m",
    refreshExpiresIn = "7d",
    maxAttempts = 5,
    lockMs = 15 * 60 * 1000,
    now = () => new Date(),
  }) {
    this.citizenRepository = citizenRepository;
    this.refreshTokenRepository = refreshTokenRepository;
    this.secrets = secrets;
    this.auditLogger = auditLogger;
    this.accessSeconds = parseDuration(accessExpiresIn);
    this.refreshSeconds = parseDuration(refreshExpiresIn);
    if (!this.accessSeconds || !this.refreshSeconds) throw new Error("AuthService: vigencia de tokens invalida");
    this.maxAttempts = maxAttempts;
    this.lockMs = lockMs;
    this.now = now;
  }

  async _audit(documento, outcome, reason, metadata, action = "ciudadano.login") {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({
        actor: String(documento),
        actorType: "ciudadano",
        action,
        resource: `ciudadano:${documento}`,
        resourceOwner: String(documento),
        outcome,
        reason,
        metadata,
      });
    } catch (auditErr) {
      // Igual que en el registro: un fallo de auditoria se reporta, no tumba el login.
      logger.error("audit.write_failed", { action, err: auditErr });
    }
  }

  async _issueTokens(citizen) {
    const base = { issuer: ISSUER, subject: String(citizen._id) };
    const refreshJti = crypto.randomUUID();
    const accessToken = this.secrets.sign({ typ: "access" }, { ...base, expiresIn: this.accessSeconds, jwtid: crypto.randomUUID() });
    const refreshToken = this.secrets.sign({ typ: "refresh" }, { ...base, expiresIn: this.refreshSeconds, jwtid: refreshJti });
    // Se recuerda el jti para poder hacerlo de un solo uso. Si esto falla no se entrega un refresh token que no se podria canjear.
    await this.refreshTokenRepository.create({
      jti: refreshJti,
      ciudadanoId: citizen._id,
      expiresAt: new Date(this.now().getTime() + this.refreshSeconds * 1000),
    });
    return { accessToken, refreshToken, expiresIn: this.accessSeconds };
  }

  async login({ documento, password } = {}) {
    if (!isValidDocumento(documento) || typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      throw new ValidationError("documento y password son requeridos");
    }
    const doc = Number(documento);

    let citizen = await this.citizenRepository.findByDocumento(doc);

    // Siempre una verificacion Argon2 (contra el resumen real o el descartable): tiempo uniforme.
    const passwordOk = await argon2.verify(citizen ? citizen.passwordHash : await dummyHash(), password).catch(() => false);

    if (!citizen) {
      await this._audit(doc, "fallo", "documento_no_registrado");
      throw new InvalidCredentialsError();
    }

    const now = this.now();
    if (citizen.bloqueadoHasta) {
      if (citizen.bloqueadoHasta > now) {
        // No se cuentan mas intentos durante el bloqueo: si no, un atacante mantendria bloqueada a la victima para siempre.
        await this._audit(doc, "rechazo", "cuenta_bloqueada");
        throw new InvalidCredentialsError();
      }
      citizen = await this.citizenRepository.resetLoginAttempts(citizen._id); // bloqueo vencido: se empieza de cero
    }

    if (!passwordOk) {
      const updated = await this.citizenRepository.registerFailedAttempt(citizen._id, {
        maxAttempts: this.maxAttempts,
        lockUntil: new Date(now.getTime() + this.lockMs),
      });
      const locked = Boolean(updated && updated.bloqueadoHasta && updated.bloqueadoHasta > now);
      if (locked) logger.warn("auth.cuenta_bloqueada", { maxAttempts: this.maxAttempts });
      await this._audit(doc, "fallo", "password_incorrecto", { intentosFallidos: updated ? updated.intentosFallidos : undefined, bloqueada: locked });
      throw new InvalidCredentialsError();
    }

    if (citizen.estado !== "activo") {
      await this._audit(doc, "rechazo", `estado_${citizen.estado}`);
      throw new InvalidCredentialsError();
    }

    if (citizen.intentosFallidos > 0) await this.citizenRepository.resetLoginAttempts(citizen._id);

    const tokens = await this._issueTokens(citizen);
    await this._audit(doc, "exito");
    return tokens;
  }

  /** Canjea un refresh token (un solo uso) por un access token y un refresh token nuevos. */
  async refresh({ refreshToken } = {}) {
    if (typeof refreshToken !== "string" || !refreshToken) throw new ValidationError("refreshToken es requerido");

    let payload;
    try {
      payload = this.secrets.verify(refreshToken);
    } catch {
      throw new InvalidTokenError();
    }
    // Un access token (o de otro emisor) no puede canjearse aqui.
    if (payload.typ !== "refresh" || payload.iss !== ISSUER || !payload.sub || !payload.jti) throw new InvalidTokenError();

    const now = this.now();
    const used = await this.refreshTokenRepository.consume(payload.jti, now);
    if (used.status === "unknown") throw new InvalidTokenError();

    const citizen = await this.citizenRepository.findById(payload.sub);
    if (!citizen) throw new InvalidTokenError();

    if (used.status === "reused") {
      // Ya se habia canjeado: o lo uso un atacante o lo uso el duenio despues de que otro lo copiara. No se sabe
      // quien es quien, asi que se cierran todas las sesiones del ciudadano y debe volver a iniciar sesion.
      const revoked = await this.refreshTokenRepository.revokeAllFor(citizen._id, now);
      logger.warn("auth.refresh_reutilizado", { revoked });
      await this._audit(citizen.documento, "rechazo", "refresh_reutilizado", { revoked }, "ciudadano.refresh");
      throw new InvalidTokenError();
    }

    // Misma regla que el login: una cuenta bloqueada o que ya no esta activa no renueva sesion.
    const locked = Boolean(citizen.bloqueadoHasta && citizen.bloqueadoHasta > now);
    if (citizen.estado !== "activo" || locked) {
      await this._audit(citizen.documento, "rechazo", citizen.estado !== "activo" ? `estado_${citizen.estado}` : "cuenta_bloqueada", undefined, "ciudadano.refresh");
      throw new InvalidTokenError();
    }

    const tokens = await this._issueTokens(citizen);
    await this._audit(citizen.documento, "exito", undefined, undefined, "ciudadano.refresh");
    return tokens;
  }
}

module.exports = { AuthService, InvalidCredentialsError, InvalidTokenError, ISSUER };
