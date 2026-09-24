/**
 * Validacion de configuracion al arranque del gateway (HT-07, ADR-06). Misma politica que ms-identidad:
 * falla rapido, con TODOS los problemas a la vez, sin imprimir nunca el valor de un secreto.
 * Es el subconjunto que aplica al gateway (llave JWT, TLS propio y URLs de los servicios destino).
 */

const MIN_SECRET_LENGTH = 32;

const PLACEHOLDER_FRAGMENTS = ["cambiar-en-produccion", "solo-para-desarrollo", "changeme", "change-me", "example", "your-secret", "password"];

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

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function validateConfig(cfg) {
  const problems = [];

  if (!cfg.isLocal) {
    // Debe ser LA MISMA llave que usa ms-identidad para firmar: si no, el gateway rechazaria todos los tokens.
    const jwtProblem = secretProblem(cfg.jwtSecret);
    if (jwtProblem) problems.push(`JWT_SECRET ${jwtProblem} (minimo ${MIN_SECRET_LENGTH} caracteres, la misma que usa ms-identidad)`);
    (cfg.jwtSecretPrevious || []).forEach((s, i) => {
      const p = secretProblem(s);
      if (p) problems.push(`JWT_SECRET_PREVIOUS[${i}] ${p}`);
    });

    // ADR-07: llave de los tokens INSTITUCIONALES. Es OPCIONAL mientras ninguna ruta de entidad este declarada
    // (sin ella esas rutas responden 401); si se define, debe ser la misma que usa ms-comparticion para firmar.
    if (cfg.entityJwtSecret) {
      const entityProblem = secretProblem(cfg.entityJwtSecret);
      if (entityProblem) problems.push(`ENTITY_JWT_SECRET ${entityProblem} (minimo ${MIN_SECRET_LENGTH} caracteres, la misma que usa ms-comparticion)`);
      (cfg.entityJwtSecretPrevious || []).forEach((s, i) => {
        const p = secretProblem(s);
        if (p) problems.push(`ENTITY_JWT_SECRET_PREVIOUS[${i}] ${p}`);
      });
    }
  }

  // Aplica en TODO ambiente, tambien en local: si las dos llaves fueran la misma, un token de ciudadano valdria
  // como institucional y al reves, que es exactamente lo que ADR-07 separa. Se compara sin imprimir los valores.
  if (cfg.entityJwtSecret && cfg.jwtSecret && cfg.entityJwtSecret === cfg.jwtSecret) {
    problems.push("ENTITY_JWT_SECRET no puede ser igual a JWT_SECRET (los tokens de entidad y de ciudadano se firman con llaves distintas, ADR-07)");
  }

  for (const [name, url] of Object.entries(cfg.upstreams || {})) {
    if (!isHttpUrl(url)) problems.push(`${name} debe ser una URL http(s) valida`);
  }

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

module.exports = { validateConfig, assertValidConfig, secretProblem, ConfigError, MIN_SECRET_LENGTH };
