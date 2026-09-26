/**
 * Validacion de configuracion al arranque de ms-interoperabilidad (HT-07, ADR-06). Misma politica que los demas
 * servicios: falla rapido, con TODOS los problemas a la vez, sin imprimir nunca el valor de un secreto.
 * Lo propio de este servicio: la politica de refresco del directorio de operadores y la seguridad de las URLs.
 */

const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_FRAGMENTS = ["cambiar-en-produccion", "solo-para-desarrollo", "changeme", "change-me", "example", "your-secret", "password"];
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

    // HU-05c: token del ciudadano (misma llave que ms-identidad), broker con TLS y direccion publica con TLS: por ella
    // otro operador nos confirma una transferencia (y con ella borramos los datos de un ciudadano).
    const jwtProblem = secretProblem(cfg.jwtSecret);
    if (jwtProblem) problems.push(`JWT_SECRET ${jwtProblem} (minimo ${MIN_SECRET_LENGTH} caracteres, la misma que usa ms-identidad)`);
    (cfg.jwtSecretPrevious || []).forEach((s, i) => {
      const p = secretProblem(s);
      if (p) problems.push(`JWT_SECRET_PREVIOUS[${i}] ${p}`);
    });
    if (!/^amqps:\/\//i.test(cfg.rabbitUri || "")) problems.push("RABBITMQ_URI debe usar amqps:// (RabbitMQ con TLS)");
    if (!/^https:\/\//i.test(cfg.publicBaseUrl || "")) problems.push("PUBLIC_BASE_URL debe usar https://");
  }

  if (cfg.publicBaseUrl !== undefined) {
    let ok = false;
    try {
      const u = new URL(cfg.publicBaseUrl);
      ok = (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      ok = false;
    }
    if (!ok) problems.push("PUBLIC_BASE_URL debe ser una URL http(s) sin credenciales, consulta ni fragmento");
  }
  if (cfg.operatorName !== undefined && (typeof cfg.operatorName !== "string" || !cfg.operatorName.trim() || cfg.operatorName.length > 100)) {
    problems.push("OPERATOR_NAME es obligatorio (el mismo nombre registrado en GovCarpeta)");
  }
  const t = cfg.transfer;
  if (t) {
    for (const [name, value] of [
      ["TRANSFER_CONFIRM_TIMEOUT_MS", t.confirmTimeoutMs],
      ["TRANSFER_MAX_SEND_ATTEMPTS", t.maxSendAttempts],
      ["TRANSFER_STEP_TIMEOUT_MS", t.stepTimeoutMs],
      ["TRANSFER_MAX_DOCUMENTS", t.maxDocuments],
      ["TRANSFER_PEER_TIMEOUT_MS", t.peerTimeoutMs],
    ]) {
      if (!isPositiveInt(value)) problems.push(`${name} debe ser un entero positivo`);
    }
    if (!Number.isInteger(t.sweepIntervalMs) || t.sweepIntervalMs < 0) problems.push("TRANSFER_SWEEP_INTERVAL_MS debe ser un entero >= 0");
  }
  if (cfg.eventPublishTimeoutMs !== undefined && !isPositiveInt(cfg.eventPublishTimeoutMs)) problems.push("EVENT_PUBLISH_TIMEOUT_MS debe ser un entero positivo");

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

module.exports = { validateConfig, assertValidConfig, ConfigError, secretProblem, MIN_SECRET_LENGTH, MIN_TTL_MINUTES, MAX_TTL_MINUTES };
