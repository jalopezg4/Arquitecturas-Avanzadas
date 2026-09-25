const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { secretProblem } = require("../config/ConfigValidator");

const ALGORITHM = "HS256";

/** Identificador publico de una llave (para el header `kid`); no revela el secreto. */
function keyId(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

/**
 * Llavero de firma JWT que permite ROTAR sin tumbar sesiones (HT-07). Es el MISMO mecanismo que usan
 * ms-identidad, ms-documentos y ms-gateway para los tokens de ciudadano; aqui gobierna la llave propia de los
 * tokens INSTITUCIONALES (ENTITY_JWT_SECRET, ADR-07). Cada servicio monta el suyo (ADR-06).
 *
 * - Siempre se firma con la llave activa.
 * - Se verifica con la activa y con las anteriores, hasta que se retiran. Asi, al rotar, los
 *   tokens ya emitidos siguen siendo validos y nadie pierde la sesion.
 * - Procedimiento: rotate(nueva) -> esperar a que expire el token mas longevo -> retirePrevious().
 */
class SecretsManager {
  constructor({ active, previous = [] }) {
    if (!active) throw new Error("SecretsManager: se requiere una llave activa");
    this.active = active;
    this.previous = [...previous];
  }

  status() {
    return { activeKid: keyId(this.active), previousKids: this.previous.map(keyId) };
  }

  sign(payload, options = {}) {
    return jwt.sign(payload, this.active, { ...options, algorithm: ALGORITHM, keyid: keyId(this.active) });
  }

  /** Verifica firma, expiracion y algoritmo. Lanza si el token no es valido. */
  verify(token) {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded && decoded.header && decoded.header.kid;
    const secret = [this.active, ...this.previous].find((s) => keyId(s) === kid);
    if (!secret) throw new jwt.JsonWebTokenError("llave desconocida o ya retirada");
    // Se fija el algoritmo: evita `alg: none` y confusion entre algoritmos.
    return jwt.verify(token, secret, { algorithms: [ALGORITHM] });
  }

  /** La activa pasa a "anterior" (sigue verificando) y la nueva empieza a firmar. */
  rotate(newSecret) {
    const problem = secretProblem(newSecret);
    if (problem) throw new Error(`SecretsManager: la nueva llave ${problem}`);
    if (newSecret === this.active || this.previous.includes(newSecret)) {
      throw new Error("SecretsManager: la nueva llave debe ser distinta a las existentes");
    }
    this.previous.unshift(this.active);
    this.active = newSecret;
    return this.status();
  }

  /** Deja de aceptar las llaves anteriores (cuando ya expiraron todos los tokens que firmaron). */
  retirePrevious() {
    const retired = this.previous.length;
    this.previous = [];
    return retired;
  }
}

module.exports = SecretsManager;
