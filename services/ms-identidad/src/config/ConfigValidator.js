/**
 * Validacion de configuracion al arranque (HT-07, ADR-06). Falla rapido y con TODOS los
 * problemas a la vez, sin imprimir nunca el valor de un secreto.
 */

const MIN_SECRET_LENGTH = 32;

// Valores que nunca deben llegar a un ambiente real: son los de .env.example, del dev local
// o los tipicos de tutoriales.
const PLACEHOLDER_FRAGMENTS = ["cambiar-en-produccion", "solo-para-desarrollo", "changeme", "change-me", "example", "your-secret", "password"];
const WEAK_URI_PASSWORDS = new Set(["guest", "admin", "root", "password", "123456", "changeme", "test"]);

// Politica de expiracion de URLs prefirmadas (ADR-06): vigencia limitada, con tope por caso de uso.
const PRESIGNED_POLICY = {
  authTtlSeconds: { max: 15 * 60, label: "PRESIGNED_URL_AUTH_TTL_SECONDS (autenticacion en GovCarpeta, HU-04)" },
  downloadTtlSeconds: { max: 60 * 60, label: "PRESIGNED_URL_DOWNLOAD_TTL_SECONDS (descarga del ciudadano, HU-09)" },
};

class ConfigError extends Error {
  constructor(problems) {
    super(`Configuracion invalida:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function secretProblem(secret) {
  if (typeof secret !== "string" || secret.length === 0) return "esta vacio";
  // Primero el placeholder: es la causa real y el mensaje mas util (ej. .env.example copiado tal cual).
  const lower = secret.toLowerCase();
  if (PLACEHOLDER_FRAGMENTS.some((p) => lower.includes(p))) return "es un valor de ejemplo/placeholder";
  if (secret.length < MIN_SECRET_LENGTH) return `tiene menos de ${MIN_SECRET_LENGTH} caracteres`;
  if (new Set(secret).size < 10) return "tiene muy poca variedad de caracteres";
  return null;
}

function isStrongSecret(secret) {
  return secretProblem(secret) === null;
}

function uriPassword(uri) {
  const match = /^[a-z0-9+.-]+:\/\/[^:@/\s]+:([^@/\s]*)@/i.exec(uri || "");
  return match ? decodeURIComponent(match[1]) : null;
}

function validateConfig(cfg) {
  const problems = [];
  const local = cfg.isLocal;

  if (!local) {
    const jwtProblem = secretProblem(cfg.jwtSecret);
    if (jwtProblem) problems.push(`JWT_SECRET ${jwtProblem} (minimo ${MIN_SECRET_LENGTH} caracteres, aleatorio)`);
    (cfg.jwtSecretPrevious || []).forEach((s, i) => {
      const p = secretProblem(s);
      if (p) problems.push(`JWT_SECRET_PREVIOUS[${i}] ${p}`);
    });

    // Trafico cifrado hacia todo lo externo. Si la plataforma no lo soporta, es una decision
    // consciente que se documenta, no un default silencioso.
    if (!/^https:\/\//i.test(cfg.govCarpetaBaseUrl || "")) problems.push("GOVCARPETA_BASE_URL debe usar https://");
    if (!/^amqps:\/\//i.test(cfg.rabbitUri || "")) problems.push("RABBITMQ_URI debe usar amqps:// (RabbitMQ con TLS)");
    const mongo = cfg.mongoUri || "";
    if (/[?&](?:tls|ssl)=(?:false|0)(?:&|$)/i.test(mongo)) {
      // Se evalua primero: mongodb+srv:// activa TLS por defecto, pero ?tls=false lo apaga.
      problems.push("MONGO_URI desactiva TLS (tls=false / ssl=false)");
    } else if (!/^mongodb\+srv:\/\//i.test(mongo) && !/[?&](?:tls|ssl)=true(?:&|$)/i.test(mongo)) {
      problems.push("MONGO_URI debe usar TLS (mongodb+srv:// o ?tls=true)");
    }
    if (/[?&](?:tlsInsecure|tlsAllowInvalidCertificates|tlsAllowInvalidHostnames|sslValidate)=(?:true|false)/i.test(mongo)) {
      const risky = /[?&]sslValidate=false/i.test(mongo) || /[?&](?:tlsInsecure|tlsAllowInvalidCertificates|tlsAllowInvalidHostnames)=true/i.test(mongo);
      if (risky) problems.push("MONGO_URI desactiva la validacion del certificado TLS (tlsInsecure / tlsAllowInvalid* / sslValidate=false)");
    }

    for (const [name, uri] of [["MONGO_URI", cfg.mongoUri], ["RABBITMQ_URI", cfg.rabbitUri]]) {
      const pass = uriPassword(uri);
      if (pass !== null && (WEAK_URI_PASSWORDS.has(pass.toLowerCase()) || pass.length < 8)) {
        problems.push(`${name} contiene una contrasena debil o por defecto`);
      }
    }
  }

  const tls = cfg.tls || {};
  if (Boolean(tls.certPath) !== Boolean(tls.keyPath)) problems.push("TLS_CERT_PATH y TLS_KEY_PATH deben definirse juntos");
  if (tls.caPath && !(tls.certPath && tls.keyPath)) problems.push("TLS_CA_PATH (mTLS) requiere TLS_CERT_PATH y TLS_KEY_PATH");
  if (tls.required && !(tls.certPath && tls.keyPath)) problems.push("REQUIRE_TLS=true exige TLS_CERT_PATH y TLS_KEY_PATH");

  for (const [key, rule] of Object.entries(PRESIGNED_POLICY)) {
    const value = cfg.presignedUrl ? cfg.presignedUrl[key] : undefined;
    if (!Number.isInteger(value) || value <= 0) problems.push(`${rule.label} debe ser un entero positivo`);
    else if (value > rule.max) problems.push(`${rule.label} no puede superar ${rule.max}s (politica de expiracion, ADR-06)`);
  }

  return problems;
}

function assertValidConfig(cfg) {
  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(problems);
}

module.exports = { validateConfig, assertValidConfig, isStrongSecret, secretProblem, ConfigError, MIN_SECRET_LENGTH, PRESIGNED_POLICY };
