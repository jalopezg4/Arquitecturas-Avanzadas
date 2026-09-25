/**
 * Validacion de configuracion al arranque de ms-analitica (HU-07, ADR-06). Misma politica que los demas
 * servicios: falla rapido, con TODOS los problemas a la vez, sin imprimir nunca el valor de un secreto.
 * Ademas de Mongo, valida la llave con la que se VERIFICAN los tokens institucionales (HU-07.2, ADR-07).
 */

const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_FRAGMENTS = ["cambiar-en-produccion", "solo-para-desarrollo", "changeme", "change-me", "example", "your-secret", "password"];
const WEAK_URI_PASSWORDS = new Set(["guest", "admin", "root", "password", "123456", "changeme", "test"]);

class ConfigError extends Error {
  constructor(problems) {
    super(`Configuracion invalida:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function secretProblem(secret) {
  if (typeof secret !== "string" || secret.length === 0) return "esta vacio";
  const lower = secret.toLowerCase();
  if (PLACEHOLDER_FRAGMENTS.some((p) => lower.includes(p))) return "es un valor de ejemplo/placeholder";
  if (secret.length < MIN_SECRET_LENGTH) return `tiene menos de ${MIN_SECRET_LENGTH} caracteres`;
  if (new Set(secret).size < 10) return "tiene muy poca variedad de caracteres";
  return null;
}

function uriPassword(uri) {
  const match = /^[a-z0-9+.-]+:\/\/[^:@/\s]+:([^@/\s]*)@/i.exec(uri || "");
  return match ? decodeURIComponent(match[1]) : null;
}

// Igual que en ms-gateway: la URL de un upstream interno (Docker) es http:// por diseno, asi que no se exige
// https ni siquiera fuera de local -- solo que sea una URL http(s) valida.
function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

function validateConfig(cfg) {
  const problems = [];

  if (!isHttpUrl(cfg.documentosUrl)) problems.push("DOCUMENTOS_URL debe ser una URL http(s) valida");
  if (!isPositiveInt(cfg.documentsAnalyticsTimeoutMs)) problems.push("DOCUMENTS_ANALYTICS_TIMEOUT_MS debe ser un entero positivo");

  if (!cfg.isLocal) {
    const mongo = cfg.mongoUri || "";
    if (/[?&](?:tls|ssl)=(?:false|0)(?:&|$)/i.test(mongo)) problems.push("MONGO_URI desactiva TLS (tls=false / ssl=false)");
    else if (!/^mongodb\+srv:\/\//i.test(mongo) && !/[?&](?:tls|ssl)=true(?:&|$)/i.test(mongo)) problems.push("MONGO_URI debe usar TLS (mongodb+srv:// o ?tls=true)");
    if (/[?&]sslValidate=false/i.test(mongo) || /[?&](?:tlsInsecure|tlsAllowInvalidCertificates|tlsAllowInvalidHostnames)=true/i.test(mongo)) {
      problems.push("MONGO_URI desactiva la validacion del certificado TLS (tlsInsecure / tlsAllowInvalid* / sslValidate=false)");
    }
    const pass = uriPassword(mongo);
    if (pass !== null && (WEAK_URI_PASSWORDS.has(pass.toLowerCase()) || pass.length < 8)) problems.push("MONGO_URI contiene una contrasena debil o por defecto");

    // ADR-07: sin ella, /api/v1/cases (HU-07.2) responderia 401 siempre. Debe ser la MISMA que usa ms-comparticion
    // para firmar, si no, este servicio rechazaria todos los tokens institucionales.
    const entityProblem = secretProblem(cfg.entityJwtSecret);
    if (entityProblem) problems.push(`ENTITY_JWT_SECRET ${entityProblem} (minimo ${MIN_SECRET_LENGTH} caracteres, la misma que usa ms-comparticion)`);
    (cfg.entityJwtSecretPrevious || []).forEach((s, i) => {
      const p = secretProblem(s);
      if (p) problems.push(`ENTITY_JWT_SECRET_PREVIOUS[${i}] ${p}`);
    });
  }

  return problems;
}

function assertValidConfig(cfg) {
  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(problems);
}

module.exports = { validateConfig, assertValidConfig, secretProblem, ConfigError, MIN_SECRET_LENGTH };
