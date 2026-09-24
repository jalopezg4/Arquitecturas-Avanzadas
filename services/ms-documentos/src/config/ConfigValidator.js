/**
 * Validacion de configuracion al arranque de ms-documentos (HT-07, ADR-06). Misma politica que ms-identidad: falla
 * rapido, con TODOS los problemas a la vez, sin imprimir nunca el valor de un secreto. Incluye lo propio de este
 * servicio: object storage S3, cuota de documentos no certificados y tamano maximo de carga.
 */

const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_FRAGMENTS = ["cambiar-en-produccion", "solo-para-desarrollo", "changeme", "change-me", "example", "your-secret", "password"];
const WEAK_URI_PASSWORDS = new Set(["guest", "admin", "root", "password", "123456", "changeme", "test"]);
// Credenciales por defecto de MinIO/S3 de tutoriales: nunca deben llegar a un ambiente real.
const WEAK_S3_KEYS = new Set(["minioadmin", "minio", "admin", "root", "test", "changeme", "password", "accesskey", "secretkey"]);

// Politica de expiracion de URLs prefirmadas (ADR-06): la descarga propia del ciudadano vive como maximo 1 hora.
const MAX_DOWNLOAD_TTL_SECONDS = 60 * 60;
const MAX_STORAGE_TOTAL_MS = 9000; // por debajo del plazo por defecto del gateway (10 s)
const MAX_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024; // tope duro: un valor mayor casi siempre es un error de configuracion

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
    // Debe ser la MISMA llave con la que ms-identidad firma: si no, este servicio rechazaria todos los tokens.
    const jwtProblem = secretProblem(cfg.jwtSecret);
    if (jwtProblem) problems.push(`JWT_SECRET ${jwtProblem} (minimo ${MIN_SECRET_LENGTH} caracteres, la misma que usa ms-identidad)`);
    (cfg.jwtSecretPrevious || []).forEach((s, i) => {
      const p = secretProblem(s);
      if (p) problems.push(`JWT_SECRET_PREVIOUS[${i}] ${p}`);
    });

    // ADR-07: llave de los tokens INSTITUCIONALES. Todavia OPCIONAL (ninguna ruta la usa; la primera sera HU-10);
    // si se define, debe ser la misma que usa ms-comparticion para firmar.
    if (cfg.entityJwtSecret) {
      const entityProblem = secretProblem(cfg.entityJwtSecret);
      if (entityProblem) problems.push(`ENTITY_JWT_SECRET ${entityProblem} (minimo ${MIN_SECRET_LENGTH} caracteres, la misma que usa ms-comparticion)`);
      (cfg.entityJwtSecretPrevious || []).forEach((s, i) => {
        const p = secretProblem(s);
        if (p) problems.push(`ENTITY_JWT_SECRET_PREVIOUS[${i}] ${p}`);
      });
    }

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

    // Object storage: cifrado en transito y credenciales que no sean las de tutorial.
    const s3 = cfg.s3 || {};
    if (!/^https:\/\//i.test(s3.endpoint || "")) problems.push("S3_ENDPOINT debe usar https://");
    for (const [name, value] of [["S3_ACCESS_KEY_ID", s3.accessKeyId], ["S3_SECRET_ACCESS_KEY", s3.secretAccessKey]]) {
      if (!value) problems.push(`${name} es obligatorio`);
      else if (WEAK_S3_KEYS.has(String(value).toLowerCase())) problems.push(`${name} es una credencial por defecto/debil`);
    }
  }

  // Aplica en TODO ambiente: si las dos llaves fueran la misma, un token de ciudadano valdria como institucional
  // y al reves, que es exactamente lo que ADR-07 separa. Se compara sin imprimir los valores.
  if (cfg.entityJwtSecret && cfg.jwtSecret && cfg.entityJwtSecret === cfg.jwtSecret) {
    problems.push("ENTITY_JWT_SECRET no puede ser igual a JWT_SECRET (los tokens de entidad y de ciudadano se firman con llaves distintas, ADR-07)");
  }

  const s3 = cfg.s3 || {};
  if (!s3.bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3.bucket)) problems.push("S3_BUCKET debe ser un nombre de bucket valido (minusculas, numeros, punto y guion)");

  for (const [name, value] of [["S3_CONNECT_TIMEOUT_MS", s3.connectTimeoutMs], ["S3_REQUEST_TIMEOUT_MS", s3.requestTimeoutMs]]) {
    if (value !== undefined && !isPositiveInt(value)) problems.push(`${name} debe ser un entero positivo`);
  }
  // 2 intentos de (conexion + solicitud) deben caber antes del plazo del gateway (10 s por defecto).
  if (isPositiveInt(s3.connectTimeoutMs) && isPositiveInt(s3.requestTimeoutMs) && 2 * (s3.connectTimeoutMs + s3.requestTimeoutMs) > MAX_STORAGE_TOTAL_MS) {
    problems.push(`S3_CONNECT_TIMEOUT_MS y S3_REQUEST_TIMEOUT_MS: 2 intentos no pueden superar ${MAX_STORAGE_TOTAL_MS} ms (deben rendirse antes que el gateway)`);
  }

  const limits = cfg.limits || {};
  if (!isPositiveInt(limits.quotaNoCertificados)) problems.push("QUOTA_NO_CERTIFICADOS debe ser un entero positivo");
  if (!isPositiveInt(limits.maxUploadBytes)) problems.push("MAX_UPLOAD_BYTES debe ser un entero positivo");
  else if (limits.maxUploadBytes > MAX_UPLOAD_LIMIT_BYTES) problems.push(`MAX_UPLOAD_BYTES no puede superar ${MAX_UPLOAD_LIMIT_BYTES} (50 MB)`);
  // HU-10: la recepcion institucional puede aceptar mas que la carga del ciudadano, pero nunca mas que el tope duro:
  // el archivo entero pasa por memoria y ese tope es lo que el servicio soporta sin rediseno.
  if (limits.maxInboundBytes !== undefined) {
    if (!isPositiveInt(limits.maxInboundBytes)) problems.push("MAX_INBOUND_UPLOAD_BYTES debe ser un entero positivo");
    else if (limits.maxInboundBytes > MAX_UPLOAD_LIMIT_BYTES) problems.push(`MAX_INBOUND_UPLOAD_BYTES no puede superar ${MAX_UPLOAD_LIMIT_BYTES} (50 MB): el archivo se procesa en memoria`);
    else if (isPositiveInt(limits.maxUploadBytes) && limits.maxInboundBytes < limits.maxUploadBytes) {
      problems.push("MAX_INBOUND_UPLOAD_BYTES no puede ser menor que MAX_UPLOAD_BYTES (un certificado no puede admitir menos que una carga del ciudadano)");
    }
  }

  const ttl = cfg.presignedDownloadTtlSeconds;
  if (!isPositiveInt(ttl)) problems.push("PRESIGNED_URL_DOWNLOAD_TTL_SECONDS debe ser un entero positivo");
  else if (ttl > MAX_DOWNLOAD_TTL_SECONDS) problems.push(`PRESIGNED_URL_DOWNLOAD_TTL_SECONDS no puede superar ${MAX_DOWNLOAD_TTL_SECONDS}s (politica de expiracion, ADR-06)`);

  const tls = cfg.tls || {};
  if (Boolean(tls.certPath) !== Boolean(tls.keyPath)) problems.push("TLS_CERT_PATH y TLS_KEY_PATH deben definirse juntos");
  if (tls.caPath && !(tls.certPath && tls.keyPath)) problems.push("TLS_CA_PATH (mTLS) requiere TLS_CERT_PATH y TLS_KEY_PATH");
  if (tls.required && !(tls.certPath && tls.keyPath)) problems.push("REQUIRE_TLS=true exige TLS_CERT_PATH y TLS_KEY_PATH");

  return problems;
}

function assertValidConfig(cfg) {
  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(problems);
}

module.exports = { MAX_STORAGE_TOTAL_MS, validateConfig, assertValidConfig, secretProblem, ConfigError, MIN_SECRET_LENGTH, MAX_DOWNLOAD_TTL_SECONDS, MAX_UPLOAD_LIMIT_BYTES };
