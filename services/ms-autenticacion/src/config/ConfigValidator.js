/**
 * Validacion de configuracion al arranque de ms-autenticacion (HT-07, ADR-06). Misma politica que el resto de
 * servicios: falla rapido, con TODOS los problemas a la vez, sin imprimir nunca el valor de un secreto. Lo propio de
 * este servicio: GovCarpeta (HTTPS fuera de local), el object storage con el que firma las URLs y la vigencia de esas
 * URLs (15 minutos como maximo, ADR-06 / RNF-13).
 */

const WEAK_URI_PASSWORDS = new Set(["guest", "admin", "root", "password", "123456", "changeme", "test"]);
// Credenciales por defecto de MinIO/S3 de tutoriales: nunca deben llegar a un ambiente real.
const WEAK_S3_KEYS = new Set(["minioadmin", "minio", "admin", "root", "test", "changeme", "password", "accesskey", "secretkey"]);

// Politica de expiracion de URLs prefirmadas (ADR-06): la URL que se entrega a GovCarpeta vive como maximo 15 minutos.
const MAX_AUTH_TTL_SECONDS = 15 * 60;
// Reintentos contra GovCarpeta (HU-04: "maximo 3" antes de dar la autenticacion por fallida).
const MAX_GOVCARPETA_ATTEMPTS = 3;

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

    const s3 = cfg.s3 || {};
    if (!/^https:\/\//i.test(s3.endpoint || "")) problems.push("S3_ENDPOINT debe usar https://");
    // La URL firmada la abre GovCarpeta desde internet: el host publico tambien debe ser https.
    if (s3.publicEndpoint && !/^https:\/\//i.test(s3.publicEndpoint)) problems.push("S3_PUBLIC_ENDPOINT debe usar https://");
    for (const [name, value] of [["S3_ACCESS_KEY_ID", s3.accessKeyId], ["S3_SECRET_ACCESS_KEY", s3.secretAccessKey]]) {
      if (!value) problems.push(`${name} es obligatorio`);
      else if (WEAK_S3_KEYS.has(String(value).toLowerCase())) problems.push(`${name} es una credencial por defecto/debil`);
    }

    if (!/^https:\/\//i.test((cfg.govCarpeta || {}).baseUrl || "")) problems.push("GOVCARPETA_BASE_URL debe usar https://");
  }

  const s3 = cfg.s3 || {};
  if (!s3.bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3.bucket)) problems.push("S3_BUCKET debe ser un nombre de bucket valido (minusculas, numeros, punto y guion)");
  for (const [name, value] of [["S3_CONNECT_TIMEOUT_MS", s3.connectTimeoutMs], ["S3_REQUEST_TIMEOUT_MS", s3.requestTimeoutMs]]) {
    if (value !== undefined && !isPositiveInt(value)) problems.push(`${name} debe ser un entero positivo`);
  }

  const ttl = cfg.presignedAuthTtlSeconds;
  if (!isPositiveInt(ttl)) problems.push("PRESIGNED_URL_AUTH_TTL_SECONDS debe ser un entero positivo");
  else if (ttl > MAX_AUTH_TTL_SECONDS) problems.push(`PRESIGNED_URL_AUTH_TTL_SECONDS no puede superar ${MAX_AUTH_TTL_SECONDS}s (politica de expiracion, ADR-06)`);

  const gc = cfg.govCarpeta || {};
  if (!gc.baseUrl || !/^https?:\/\//i.test(gc.baseUrl)) problems.push("GOVCARPETA_BASE_URL debe ser una URL http(s)");
  if (!isPositiveInt(gc.timeoutMs)) problems.push("GOVCARPETA_TIMEOUT_MS debe ser un entero positivo");
  if (!isPositiveInt(gc.maxAttempts) || gc.maxAttempts > MAX_GOVCARPETA_ATTEMPTS) problems.push(`GOVCARPETA_MAX_ATTEMPTS debe ser un entero entre 1 y ${MAX_GOVCARPETA_ATTEMPTS}`);
  if (!isPositiveInt(gc.baseDelayMs)) problems.push("GOVCARPETA_BASE_DELAY_MS debe ser un entero positivo");

  if (!isPositiveInt(cfg.eventPublishTimeoutMs)) problems.push("EVENT_PUBLISH_TIMEOUT_MS debe ser un entero positivo");

  return problems;
}

function assertValidConfig(cfg) {
  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(problems);
}

module.exports = { validateConfig, assertValidConfig, ConfigError, MAX_AUTH_TTL_SECONDS, MAX_GOVCARPETA_ATTEMPTS };
