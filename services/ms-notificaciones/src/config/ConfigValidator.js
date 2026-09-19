/**
 * Validacion de configuracion al arranque de ms-notificaciones (HT-07, ADR-06). Misma politica que los demas
 * servicios: falla rapido, con TODOS los problemas a la vez, sin imprimir nunca el valor de un secreto.
 * Lo propio de este servicio: el transporte de correo.
 */

const WEAK_URI_PASSWORDS = new Set(["guest", "admin", "root", "password", "123456", "changeme", "test"]);
const WEAK_SMTP_PASSWORDS = new Set(["password", "changeme", "admin", "root", "test", "123456", "smtp", "mail"]);
const TRANSPORTS = ["console", "smtp"];
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

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
  const mail = cfg.mail || {};

  if (!TRANSPORTS.includes(mail.transport)) problems.push(`EMAIL_TRANSPORT debe ser uno de: ${TRANSPORTS.join(", ")}`);
  if (!mail.from || !EMAIL_RE.test(mail.from)) problems.push("MAIL_FROM debe ser un correo valido");

  if (!cfg.isLocal) {
    // Con "console" nadie recibe nada: en un ambiente real seria un fallo silencioso (el aviso se marca como enviado).
    if (mail.transport !== "smtp") problems.push("EMAIL_TRANSPORT debe ser smtp fuera de development/test (con console nadie recibe los avisos)");

    if (!/^amqps:\/\//i.test(cfg.rabbitUri || "")) problems.push("RABBITMQ_URI debe usar amqps:// (RabbitMQ con TLS)");
    const mongo = cfg.mongoUri || "";
    if (/[?&](?:tls|ssl)=(?:false|0)(?:&|$)/i.test(mongo)) problems.push("MONGO_URI desactiva TLS (tls=false / ssl=false)");
    else if (!/^mongodb\+srv:\/\//i.test(mongo) && !/[?&](?:tls|ssl)=true(?:&|$)/i.test(mongo)) problems.push("MONGO_URI debe usar TLS (mongodb+srv:// o ?tls=true)");
    if (/[?&]sslValidate=false/i.test(mongo) || /[?&](?:tlsInsecure|tlsAllowInvalidCertificates|tlsAllowInvalidHostnames)=true/i.test(mongo)) {
      problems.push("MONGO_URI desactiva la validacion del certificado TLS (tlsInsecure / tlsAllowInvalid* / sslValidate=false)");
    }
    for (const [name, uri] of [["MONGO_URI", cfg.mongoUri], ["RABBITMQ_URI", cfg.rabbitUri]]) {
      const pass = uriPassword(uri);
      if (pass !== null && (WEAK_URI_PASSWORDS.has(pass.toLowerCase()) || pass.length < 8)) problems.push(`${name} contiene una contrasena debil o por defecto`);
    }

    if (mail.transport === "smtp") {
      if (!mail.smtp.host) problems.push("SMTP_HOST es obligatorio");
      if (!mail.smtp.user) problems.push("SMTP_USER es obligatorio");
      if (!mail.smtp.pass) problems.push("SMTP_PASS es obligatorio");
      else if (WEAK_SMTP_PASSWORDS.has(String(mail.smtp.pass).toLowerCase()) || String(mail.smtp.pass).length < 8) problems.push("SMTP_PASS es una contrasena debil o por defecto");
      // Credenciales SMTP en claro por la red: exige TLS (implicito 465 o STARTTLS obligatorio).
      if (mail.smtp.security === "none") problems.push("SMTP_SECURITY=none no se permite fuera de development/test (las credenciales viajarian sin cifrar)");
    }
  }

  if (mail.transport === "smtp") {
    if (!isPositiveInt(mail.smtp.port) || mail.smtp.port > 65535) problems.push("SMTP_PORT debe ser un puerto valido");
    if (!["tls", "starttls", "none"].includes(mail.smtp.security)) problems.push("SMTP_SECURITY debe ser tls, starttls o none");
    if (!isPositiveInt(mail.smtp.timeoutMs)) problems.push("SMTP_TIMEOUT_MS debe ser un entero positivo");
  }

  if (!isPositiveInt(cfg.staleClaimMs)) problems.push("NOTIFICATION_STALE_CLAIM_MS debe ser un entero positivo");

  return problems;
}

function assertValidConfig(cfg) {
  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(problems);
}

module.exports = { validateConfig, assertValidConfig, ConfigError, TRANSPORTS };
