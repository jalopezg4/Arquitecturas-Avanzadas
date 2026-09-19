const argon2 = require("argon2");
const crypto = require("crypto");
const logger = require("../tracing/logger");
const { parseDuration } = require("../config/ConfigValidator");
const { ValidationError } = require("./CitizenSagaService");

const ISSUER = "ms-identidad";
const MAX_PASSWORD_LENGTH = 1024; // evita usar Argon2 como vector de consumo de CPU/memoria con entradas enormes

/** Unico error de credenciales: mismo mensaje para documento inexistente, password mala, cuenta bloqueada o no activa. */
class InvalidCredentialsError extends Error {
  constructor() {
    super("credenciales invalidas");
    this.name = "InvalidCredentialsError";
  }
}

/** Refresh token invalido, expirado, ya usado o de una cuenta que ya no puede iniciar sesion: siempre el mismo mensaje. */
class InvalidTokenError extends Error {
  constructor() {
    super("token invalido o expirado");
    this.name = "InvalidTokenError";
  }
}

function isValidDocumento(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n > 0 && String(v).trim() === String(n);
}

/**
 * `argon2.verify` acepta la variante (argon2i/argon2d/argon2id) que indique el prefijo del resumen. La politica es
 * Argon2id (ADR-06), asi que un resumen de otra variante no se acepta: habria que migrarlo de forma explicita.
 */
function isArgon2id(hash) {
  return typeof hash === "string" && hash.startsWith("$argon2id$");
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
 * - Toda causa de rechazo devuelve el MISMO error: no se revela si el documento existe ni si esta bloqueado.
 * - refresh(): canjea un refresh token por un par nuevo; cada refresh token vale UNA sola vez (rotacion) y si se
 *   presenta uno ya usado se revocan las sesiones del ciudadano (deteccion de robo).
 *
 * Concurrencia: la verificacion Argon2 tarda, y durante ese tiempo la cuenta puede bloquearse o un token canjearse
 * desde otra peticion. Por eso la decision final (aceptar el login, rotar el refresh) es siempre UNA operacion
 * atomica sobre la base de datos y nunca se confia en lo leido antes de esperar.
 */
class AuthService {
  constructor({
    citizenRepository,
    refreshSessionRepository,
    secrets,
    auditLogger,
    accessExpiresIn = "15m",
    refreshExpiresIn = "7d",
    maxAttempts = 5,
    lockMs = 15 * 60 * 1000,
    now = () => new Date(),
  }) {
    this.citizenRepository = citizenRepository;
    this.refreshSessionRepository = refreshSessionRepository;
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

  /** Firma el par de tokens. El refresh lleva `fam` (la sesion) y su `jti`, que es el unico vigente de esa sesion. */
  _signPair(citizen, familia, refreshJti) {
    const base = { issuer: ISSUER, subject: String(citizen._id) };
    const accessToken = this.secrets.sign({ typ: "access" }, { ...base, expiresIn: this.accessSeconds, jwtid: crypto.randomUUID() });
    const refreshToken = this.secrets.sign({ typ: "refresh", fam: familia }, { ...base, expiresIn: this.refreshSeconds, jwtid: refreshJti });
    return { accessToken, refreshToken, expiresIn: this.accessSeconds };
  }

  _refreshExpiry() {
    return new Date(this.now().getTime() + this.refreshSeconds * 1000);
  }

  /** Abre una sesion de refresh nueva y firma el par. Si la sesion no se puede guardar, no se entrega un refresh inservible. */
  async _openSession(citizen) {
    const familia = crypto.randomUUID();
    const refreshJti = crypto.randomUUID();
    await this.refreshSessionRepository.createSession({ familia, ciudadanoId: citizen._id, currentJti: refreshJti, expiresAt: this._refreshExpiry() });
    return this._signPair(citizen, familia, refreshJti);
  }

  async login({ documento, password } = {}) {
    if (!isValidDocumento(documento) || typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      throw new ValidationError("documento y password son requeridos");
    }
    const doc = Number(documento);

    let citizen = await this.citizenRepository.findByDocumento(doc);

    const supportedHash = citizen && isArgon2id(citizen.passwordHash) ? citizen.passwordHash : null;
    if (citizen && !supportedHash) logger.warn("auth.resumen_no_argon2id"); // sin datos del ciudadano: solo el hecho
    // Siempre una verificacion Argon2 (contra el resumen real o el descartable): tiempo uniforme.
    const verified = await argon2.verify(supportedHash || (await dummyHash()), password).catch(() => false);
    const passwordOk = Boolean(supportedHash) && verified;

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
      // La razon de auditoria no es una credencial; el marcador evita el falso positivo del escaner.
      await this._audit(doc, "fallo", supportedHash ? "password_incorrecto" : "resumen_no_argon2id", { // secret-scan:allow
        intentosFallidos: updated ? updated.intentosFallidos : undefined,
        bloqueada: locked,
      });
      throw new InvalidCredentialsError();
    }

    if (citizen.estado !== "activo") {
      await this._audit(doc, "rechazo", `estado_${citizen.estado}`);
      throw new InvalidCredentialsError();
    }

    // Decision final ATOMICA: lo leido arriba pudo cambiar mientras verificaba Argon2 (p. ej. cinco intentos
    // concurrentes bloquearon la cuenta). Solo se acepta si en este instante sigue activa y desbloqueada.
    const accepted = await this.citizenRepository.acceptLogin(citizen._id, now);
    if (!accepted) {
      const fresh = await this.citizenRepository.findById(citizen._id);
      await this._audit(doc, "rechazo", fresh && fresh.estado !== "activo" ? `estado_${fresh.estado}` : "cuenta_bloqueada");
      throw new InvalidCredentialsError();
    }

    const tokens = await this._openSession(accepted);
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
    // Un access token (o de otro emisor, o sin sesion) no puede canjearse aqui.
    if (payload.typ !== "refresh" || payload.iss !== ISSUER || !payload.sub || !payload.jti || !payload.fam) throw new InvalidTokenError();

    const citizen = await this.citizenRepository.findById(payload.sub);
    if (!citizen) throw new InvalidTokenError();

    // Misma regla que el login: una cuenta bloqueada o que ya no esta activa no renueva sesion.
    const now = this.now();
    const locked = Boolean(citizen.bloqueadoHasta && citizen.bloqueadoHasta > now);
    if (citizen.estado !== "activo" || locked) {
      await this._audit(citizen.documento, "rechazo", citizen.estado !== "activo" ? `estado_${citizen.estado}` : "cuenta_bloqueada", undefined, "ciudadano.refresh");
      throw new InvalidTokenError();
    }

    // Canje atomico: el token debe ser el vigente de su sesion y la sesion seguir viva; en la MISMA operacion pasa
    // a ser vigente el jti nuevo. No hay hueco entre "consumir" y "emitir" donde una revocacion pueda perderse.
    const newJti = crypto.randomUUID();
    const outcome = await this.refreshSessionRepository.rotate({
      familia: payload.fam,
      ciudadanoId: citizen._id,
      jti: payload.jti,
      newJti,
      expiresAt: this._refreshExpiry(),
    });

    if (outcome.status === "unknown") throw new InvalidTokenError();
    if (outcome.status === "revoked") {
      await this._audit(citizen.documento, "rechazo", "refresh_revocado", undefined, "ciudadano.refresh");
      throw new InvalidTokenError();
    }
    if (outcome.status === "reused") {
      // Ya se habia canjeado: o lo uso un atacante o lo uso el duenio despues de que otro lo copiara. No se sabe
      // quien es quien, asi que se cierran las sesiones del ciudadano y debe volver a iniciar sesion. Esto tambien
      // invalida el token que un canje concurrente acaba de emitir (su sesion queda revocada).
      const revoked = await this.refreshSessionRepository.revokeAllFor(citizen._id, now);
      logger.warn("auth.refresh_reutilizado", { revoked });
      await this._audit(citizen.documento, "rechazo", "refresh_reutilizado", { revoked }, "ciudadano.refresh");
      throw new InvalidTokenError();
    }

    const tokens = this._signPair(citizen, payload.fam, newJti);
    await this._audit(citizen.documento, "exito", undefined, undefined, "ciudadano.refresh");
    return tokens;
  }
}

module.exports = { AuthService, InvalidCredentialsError, InvalidTokenError, ISSUER };
