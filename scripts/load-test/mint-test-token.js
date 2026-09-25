#!/usr/bin/env node
/**
 * HT-03 -- genera un access token de CIUDADANO para la prueba de carga local, firmado con el MISMO secreto
 * de desarrollo que ya usan ms-identidad/ms-documentos/ms-gateway en local (`INSECURE_DEV_JWT_SECRET`,
 * definido en cada `services/*\/src/config/env.js`). No es una credencial real ni se introduce ningun
 * secreto nuevo: es exactamente el mismo valor ya presente en el repositorio, y NUNCA se imprime ni se
 * guarda en un archivo (solo el token firmado sale por stdout).
 *
 * Replica EXACTAMENTE lo que hace `SecretsManager.sign()` (services/*\/src/security/SecretsManager.js):
 * algoritmo HS256 y header `kid` = sha256(secreto) recortado a 12 hex -- sin el `kid` correcto,
 * `SecretsManager.verify()` rechaza el token con "llave desconocida o ya retirada".
 *
 * Uso:
 *   node mint-test-token.js
 *   JWT_TOKEN=$(node mint-test-token.js) node ...
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// Mismo valor que INSECURE_DEV_JWT_SECRET en services/ms-documentos/src/config/env.js y
// services/ms-gateway/src/config/env.js -- solo valido en NODE_ENV=development/test local.
const DEV_JWT_SECRET = "solo-para-desarrollo-local-nunca-usar-en-despliegue"; // secret-scan:allow -- valor de desarrollo ya existente en el repo, no una credencial nueva

function keyId(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.sub]      ciudadanoId sintetico (debe coincidir con el :id de la URL probada)
 * @param {string} [opts.issuer]   debe coincidir con JWT_ISSUER del servicio que verifica (por defecto "ms-identidad")
 * @param {string} [opts.jti]
 * @param {string} [opts.expiresIn]
 */
function mintToken({ sub = "ht03-loadtest-0001", issuer = "ms-identidad", jti = "ht03-loadtest", expiresIn = "2h" } = {}) {
  return jwt.sign({ sub, iss: issuer, typ: "access", jti }, DEV_JWT_SECRET, {
    algorithm: "HS256",
    keyid: keyId(DEV_JWT_SECRET),
    expiresIn,
  });
}

if (require.main === module) {
  // Solo el token por stdout -- nunca el secreto, nunca a un archivo.
  process.stdout.write(mintToken() + "\n");
}

module.exports = { mintToken, keyId, DEV_JWT_SECRET };
