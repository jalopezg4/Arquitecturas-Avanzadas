/**
 * Validacion de configuracion al arranque de ms-interoperabilidad (HT-07, ADR-06). Misma politica que los demas
 * servicios: falla rapido, con TODOS los problemas a la vez, sin imprimir nunca el valor de un secreto.
 * Lo propio de este servicio: la politica de refresco del directorio de operadores y la seguridad de las URLs.
 */

const WEAK_URI_PASSWORDS = new Set(["guest", "admin", "root", "password", "123456", "changeme", "test"]);
const OPERATOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 24 * 60;

class ConfigError extends Error {
  constructor(problems) {
    super(`Configuracion invalida:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function uriPassword(uri) {
  const match = /^[a-z0-9+.-]+:\/\/[^:@/\s]+:([^@/\s]*)@/i.exec(uri || "");
  return match ? decodeURIComponent(match[1]) : null;
}

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

function validateConfig(cfg) {
  const problems = [];

  if (!cfg.isLocal) {
    if (!/^https:\/\//i.test(cfg.govCarpetaBaseUrl || "")) problems.push("GOVCARPETA_BASE_URL debe usar https://");
    const mongo = cfg.mongoUri || "";
    if (/[?&](?:tls|ssl)=(?:false|0)(?:&|$)/i.test(mongo)) problems.push("MONGO_URI desactiva TLS (tls=false / ssl=false)");
    else if (!/^mongodb\+srv:\/\//i.test(mongo) && !/[?&](?:tls|ssl)=true(?:&|$)/i.test(mongo)) problems.push("MONGO_URI debe usar TLS (mongodb+srv:// o ?tls=true)");
    if (/[?&]sslValidate=false/i.test(mongo) || /[?&](?:tlsInsecure|tlsAllowInvalidCertificates|tlsAllowInvalidHostnames)=true/i.test(mongo)) {
      problems.push("MONGO_URI desactiva la validacion del certificado TLS (tlsInsecure / tlsAllowInvalid* / sslValidate=false)");
    }
    const pass = uriPassword(mongo);
    if (pass !== null && (WEAK_URI_PASSWORDS.has(pass.toLowerCase()) || pass.length < 8)) problems.push("MONGO_URI contiene una contrasena debil o por defecto");
    // Las direcciones de transferencia las publican OTROS operadores (no confiables): permitir IPs privadas/loopback
    // fuera de local abriria la puerta a que un operador malicioso apunte a servicios internos (SSRF).
    if (cfg.directory && cfg.directory.allowPrivateUrls) problems.push("ALLOW_PRIVATE_OPERATOR_URLS=true no se permite fuera de development/test (SSRF)");
  }

  if (cfg.operatorId && !OPERATOR_ID_RE.test(cfg.operatorId)) problems.push("OPERATOR_ID no tiene formato valido");

  const d = cfg.directory || {};
  if (!Number.isInteger(d.ttlMinutes) || d.ttlMinutes < MIN_TTL_MINUTES || d.ttlMinutes > MAX_TTL_MINUTES) {
    problems.push(`OPERATOR_DIRECTORY_TTL_MINUTES debe ser un entero entre ${MIN_TTL_MINUTES} y ${MAX_TTL_MINUTES} (1 dia)`);
  }
  if (!Number.isInteger(d.maxStaleMinutes) || d.maxStaleMinutes < 1) {
    problems.push("OPERATOR_DIRECTORY_MAX_STALE_MINUTES debe ser un entero positivo");
  } else if (Number.isInteger(d.ttlMinutes) && d.maxStaleMinutes < d.ttlMinutes) {
    problems.push("OPERATOR_DIRECTORY_MAX_STALE_MINUTES no puede ser menor que OPERATOR_DIRECTORY_TTL_MINUTES");
  }
  if (!isPositiveInt(d.minForcedRefreshSeconds)) problems.push("MIN_FORCED_REFRESH_SECONDS debe ser un entero positivo");
  if (!isPositiveInt(cfg.httpTimeoutMs)) problems.push("GOVCARPETA_TIMEOUT_MS debe ser un entero positivo");

  return problems;
}

function assertValidConfig(cfg) {
  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(problems);
}

module.exports = { validateConfig, assertValidConfig, ConfigError, MIN_TTL_MINUTES, MAX_TTL_MINUTES };
