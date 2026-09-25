const argon2 = require("argon2");
const crypto = require("crypto");
const logger = require("../tracing/logger");
const { parseDuration } = require("../config/ConfigValidator");
const { parseNit } = require("../domain/nit");
const { ENTITY_ISSUER, ENTITY_ACTOR } = require("../security/requireEntityAuth");

const MAX_PASSWORD_LENGTH = 1024; // evita usar Argon2 como vector de consumo de CPU/memoria con entradas enormes

/**
 * Unico error de autenticacion institucional: el MISMO mensaje para NIT inexistente, NIT mal formado, entidad sin
 * credencial, contrasena incorrecta o entidad bloqueada. Quien pregunta no aprende si la entidad existe.
 */
class InvalidCredentialsError extends Error {
  constructor() {
    super("credenciales invalidas");
    this.name = "InvalidCredentialsError";
  }
}

/**
 * `argon2.verify` acepta la variante (argon2i/argon2d/argon2id) que indique el prefijo del resumen. La politica es
 * Argon2id (ADR-06), asi que un resumen de otra variante no se acepta: habria que migrarlo de forma explicita.
 */
function isArgon2id(hash) {
  return typeof hash === "string" && hash.startsWith("$argon2id$");
}

// Resumen Argon2id de un valor descartable: cuando la entidad no existe se verifica contra el igual, para que
// "no existe" y "contrasena incorrecta" tarden lo mismo y no se puedan enumerar instituciones por tiempo.
let dummyHashPromise;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = argon2.hash(crypto.randomBytes(16).toString("hex"));
  return dummyHashPromise;
}

/**
 * ADR-07: autenticacion de una ENTIDAD institucional. Es el equivalente institucional de HU-02 (AuthService en
 * ms-identidad) y vive aqui porque este servicio ya es el dueno de los datos de la entidad (HU-06.1): la credencial
 * queda junto al dato que identifica, sin sincronizar nada entre servicios.
 *
 * Flujo: credenciales -> buscar institucion -> validar estado -> verificar contrasena -> emitir JWT institucional.
 *
 * - La contrasena se verifica con Argon2id, igual que la del ciudadano.
 * - El token se firma con ENTITY_JWT_SECRET (llavero propio, con `kid` y rotacion de 3 fases), NUNCA con JWT_SECRET.
 * - Lleva `act: "entidad"` e `iss: "ms-comparticion"`: no puede confundirse con uno de ciudadano.
 * - NO se emite refresh token: una entidad es un cliente maquina y vuelve a autenticarse cuando lo necesita.
 * - Cuenta intentos fallidos y bloquea temporalmente, misma politica que HU-02.
 * - `verificada` NO condiciona la autenticacion (ver docs/SEGURIDAD.md, seccion 12): hoy nada la pone en true, asi
 *   que exigirla dejaria a toda entidad sin poder autenticarse. Viaja en el token (`ver`) para que HU-10 y HU-06.3
 *   puedan exigirla al AUTORIZAR una entrega o una solicitud.
 */
class EntityAuthService {
  constructor({ institutionRepository, secrets, auditLogger, accessExpiresIn = "15m", maxAttempts = 5, lockMs = 15 * 60 * 1000, now = () => new Date() }) {
    this.institutionRepository = institutionRepository;
    this.secrets = secrets;
    this.auditLogger = auditLogger;
    this.accessSeconds = parseDuration(accessExpiresIn);
    if (!this.accessSeconds) throw new Error("EntityAuthService: vigencia de token invalida");
    this.maxAttempts = maxAttempts;
    this.lockMs = lockMs;
    this.now = now;
  }

  /** La bitacora es best-effort: un fallo al escribirla no tumba una autenticacion ya resuelta. */
  async _audit(nit, outcome, reason, institutionId) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({
        actor: String(nit),
        actorType: "entidad",
        action: "institucion.autenticar",
        resource: institutionId ? `institucion:${institutionId}` : `nit:${nit}`,
        // La entidad actua sobre SUS propias credenciales: actor y dueno coinciden, no es un acceso a algo ajeno.
        resourceOwner: String(nit),
        outcome,
        reason,
      });
    } catch (err) {
      logger.error("audit.write_failed", { action: "institucion.autenticar", err });
    }
  }

  /** Firma el access token institucional. */
  _sign(institution) {
    return this.secrets.sign(
      { typ: "access", act: ENTITY_ACTOR, ver: institution.verificada === true },
      { issuer: ENTITY_ISSUER, subject: String(institution._id), expiresIn: this.accessSeconds, jwtid: crypto.randomUUID() }
    );
  }

  /**
   * @param {{nit: string, password: string}} input
   * @returns {Promise<{accessToken: string, tokenType: string, expiresIn: number}>}
   * @throws {InvalidCredentialsError} siempre el mismo error, sea cual sea la causa
   */
  async authenticate({ nit, password } = {}) {
    const parsed = parseNit(nit);
    const passwordOk = typeof password === "string" && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;
    // Un NIT mal formado no se busca, pero igual se paga el costo de una verificacion Argon2: responder rapido
    // delataria que el NIT ni siquiera tiene forma valida.
    if (!parsed.ok || !passwordOk) {
      await argon2.verify(await dummyHash(), "x").catch(() => false);
      await this._audit(parsed.ok ? parsed.nit : "desconocido", "fallo", "entrada_invalida");
      throw new InvalidCredentialsError();
    }

    let institution = await this.institutionRepository.findByNit(parsed.nit);
    const storedHash = institution && isArgon2id(institution.passwordHash) ? institution.passwordHash : null;
    if (institution && institution.passwordHash && !storedHash) logger.warn("entidad.resumen_no_argon2id"); // sin datos de la entidad

    // SIEMPRE una verificacion Argon2 (contra el resumen real o el descartable): tiempo uniforme.
    const verified = await argon2.verify(storedHash || (await dummyHash()), password).catch(() => false);
    const credentialOk = Boolean(storedHash) && verified;

    if (!institution) {
      await this._audit(parsed.nit, "fallo", "nit_no_registrado");
      throw new InvalidCredentialsError();
    }

    const now = this.now();
    if (institution.bloqueadoHasta) {
      if (institution.bloqueadoHasta > now) {
        // No se cuentan mas intentos durante el bloqueo: si no, un atacante mantendria bloqueada a la entidad para siempre.
        await this._audit(parsed.nit, "rechazo", "entidad_bloqueada", institution._id);
        throw new InvalidCredentialsError();
      }
      institution = await this.institutionRepository.resetFailedAttempts(institution._id); // bloqueo vencido: se empieza de cero
    }

    if (!credentialOk) {
      const updated = await this.institutionRepository.registerFailedAttempt(institution._id, {
        maxAttempts: this.maxAttempts,
        lockUntil: new Date(now.getTime() + this.lockMs),
      });
      const locked = Boolean(updated && updated.bloqueadoHasta && updated.bloqueadoHasta > now);
      if (locked) logger.warn("entidad.bloqueada", { maxAttempts: this.maxAttempts });
      // La razon de auditoria no es una credencial; el marcador evita el falso positivo del escaner.
      await this._audit(parsed.nit, "fallo", storedHash ? "credencial_incorrecta" : "sin_credencial", institution._id); // secret-scan:allow
      throw new InvalidCredentialsError();
    }

    // Decision final ATOMICA: lo leido arriba pudo cambiar mientras se verificaba Argon2 (p. ej. cinco intentos
    // concurrentes bloquearon la entidad). Solo se acepta si en este instante sigue desbloqueada.
    const accepted = await this.institutionRepository.acceptAuthentication(institution._id, now);
    if (!accepted) {
      await this._audit(parsed.nit, "rechazo", "entidad_bloqueada", institution._id);
      throw new InvalidCredentialsError();
    }

    const accessToken = this._sign(accepted);
    await this._audit(parsed.nit, "exito", undefined, accepted._id);
    logger.info("entidad.autenticada", { verificada: accepted.verificada === true }); // sin NIT ni nombre
    return { accessToken, tokenType: "Bearer", expiresIn: this.accessSeconds };
  }
}

module.exports = { EntityAuthService, InvalidCredentialsError, MAX_PASSWORD_LENGTH };
