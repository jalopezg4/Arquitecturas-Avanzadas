/**
 * Validacion de configuracion al arranque de ms-comparticion (HT-07, ADR-06). Misma politica que los demas
 * servicios: falla rapido, con TODOS los problemas a la vez, sin imprimir nunca el valor de un secreto.
 *
 * Incluye lo propio de este servicio: el token opcional de registro (HU-06.1) y la llave con la que se FIRMAN
 * los tokens institucionales (ADR-07), que es distinta de la de ciudadanos (JWT_SECRET, de ms-identidad).
 */

const WEAK_URI_PASSWORDS = new Set(["guest", "admin", "root", "password", "123456", "changeme", "test"]);
const PLACEHOLDER_FRAGMENTS = ["cambiar-en-produccion", "solo-para-desarrollo", "changeme", "change-me", "example", "your-secret", "password"];
const MIN_TOKEN_LENGTH = 24;
const MIN_SECRET_LENGTH = 32;

// Politica de sesion (ADR-06): un access token vive como maximo 15 minutos. Aplica igual al token institucional.
const MAX_ACCESS_TOKEN_SECONDS = 15 * 60;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

class ConfigError extends Error {
  constructor(problems) {
    super(`Configuracion invalida:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** "15m" | "900s" | "1h" | 900 -> segundos; null si no es una duracion valida y positiva. */
function parseDuration(value) {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  const match = /^(\d+)\s*([smhd])$/i.exec(String(value || "").trim());
  if (!match) return null;
  const seconds = Number(match[1]) * UNIT_SECONDS[match[2].toLowerCase()];
  return seconds > 0 ? seconds : null;
}

function uriPassword(uri) {
  const match = /^[a-z0-9+.-]+:\/\/[^:@/\s]+:([^@/\s]*)@/i.exec(uri || "");
  return match ? decodeURIComponent(match[1]) : null;
}

function tokenProblem(token) {
  const lower = token.toLowerCase();
  if (PLACEHOLDER_FRAGMENTS.some((p) => lower.includes(p))) return "es un valor de ejemplo/placeholder";
  if (token.length < MIN_TOKEN_LENGTH) return `tiene menos de ${MIN_TOKEN_LENGTH} caracteres`;
  if (new Set(token).size < 10) return "tiene muy poca variedad de caracteres";
  return null;
}

/** Misma regla que el resto de servicios para una llave de firma JWT. */
function secretProblem(secret) {
  if (typeof secret !== "string" || secret.length === 0) return "esta vacio";
  const lower = secret.toLowerCase();
  if (PLACEHOLDER_FRAGMENTS.some((p) => lower.includes(p))) return "es un valor de ejemplo/placeholder";
  if (secret.length < MIN_SECRET_LENGTH) return `tiene menos de ${MIN_SECRET_LENGTH} caracteres`;
  if (new Set(secret).size < 10) return "tiene muy poca variedad de caracteres";
  return null;
}

function validateConfig(cfg) {
  const problems = [];

  if (!cfg.isLocal) {
    const mongo = cfg.mongoUri || "";
    if (/[?&](?:tls|ssl)=(?:false|0)(?:&|$)/i.test(mongo)) problems.push("MONGO_URI desactiva TLS (tls=false / ssl=false)");
    else if (!/^mongodb\+srv:\/\//i.test(mongo) && !/[?&](?:tls|ssl)=true(?:&|$)/i.test(mongo)) problems.push("MONGO_URI debe usar TLS (mongodb+srv:// o ?tls=true)");
    if (/[?&]sslValidate=false/i.test(mongo) || /[?&](?:tlsInsecure|tlsAllowInvalidCertificates|tlsAllowInvalidHostnames)=true/i.test(mongo)) {
      problems.push("MONGO_URI desactiva la validacion del certificado TLS (tlsInsecure / tlsAllowInvalid* / sslValidate=false)");
    }
    const pass = uriPassword(mongo);
    if (pass !== null && (WEAK_URI_PASSWORDS.has(pass.toLowerCase()) || pass.length < 8)) problems.push("MONGO_URI contiene una contrasena debil o por defecto");

    // Este servicio FIRMA los tokens institucionales (ADR-07): sin llave fuerte no debe arrancar. Es una llave
    // PROPIA, nunca la de ciudadanos: ms-identidad firma con JWT_SECRET y este servicio no la conoce.
    const entityProblem = secretProblem(cfg.entityJwtSecret);
    if (entityProblem) problems.push(`ENTITY_JWT_SECRET ${entityProblem} (minimo ${MIN_SECRET_LENGTH} caracteres, aleatorio y DISTINTO de JWT_SECRET)`);
    (cfg.entityJwtSecretPrevious || []).forEach((s, i) => {
      const p = secretProblem(s);
      if (p) problems.push(`ENTITY_JWT_SECRET_PREVIOUS[${i}] ${p}`);
    });
  }

  // La vigencia del token institucional es politica, no preferencia (igual que el access token del ciudadano).
  if (cfg.entityAccessExpiresIn !== undefined) {
    const access = parseDuration(cfg.entityAccessExpiresIn);
    if (access === null) problems.push("ENTITY_ACCESS_EXPIRES_IN debe ser una duracion valida (ej. 15m, 900s)");
    else if (access > MAX_ACCESS_TOKEN_SECONDS) problems.push(`ENTITY_ACCESS_EXPIRES_IN no puede superar ${MAX_ACCESS_TOKEN_SECONDS}s (15 minutos, ADR-06/ADR-07)`);
  }

  // El token de registro es OPCIONAL (con el, solo quien lo tenga puede registrar instituciones); si se define, debe ser fuerte.
  if (cfg.registrationToken) {
    const problem = tokenProblem(cfg.registrationToken);
    if (problem) problems.push(`REGISTRATION_TOKEN ${problem} (minimo ${MIN_TOKEN_LENGTH} caracteres, aleatorio; ej.: openssl rand -hex 24)`);
  }

  return problems;
}

function assertValidConfig(cfg) {
  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(problems);
}

module.exports = { validateConfig, assertValidConfig, ConfigError, secretProblem, parseDuration, MIN_TOKEN_LENGTH, MIN_SECRET_LENGTH, MAX_ACCESS_TOKEN_SECONDS };
