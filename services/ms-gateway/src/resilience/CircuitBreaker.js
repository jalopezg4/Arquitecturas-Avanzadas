/**
 * Cortacircuitos por servicio destino (tactica de disponibilidad: "fallar rapido", ADR-01 / matriz de degradacion).
 *
 * Sin el, cada peticion a un servicio caido espera su plazo completo (DNS + conexion) antes de recibir el error: el
 * ciudadano espera segundos por algo que ya se sabe que no va a responder, y las peticiones se acumulan en el gateway.
 *
 *   cerrado      las peticiones pasan. Un fallo de CONEXION (el servicio no esta) lo abre.
 *   abierto      durante `cooldownMs` se responde 503 de inmediato, sin intentar contactar al servicio.
 *   semiabierto  pasado el plazo se deja pasar UNA peticion de prueba; si el servicio responde, se cierra; si vuelve
 *                a fallar, se abre otra vez. Mientras la prueba esta en curso, las demas siguen recibiendo 503.
 *
 * Solo cuentan los fallos de conexion: una respuesta del servicio, aunque sea un 500, demuestra que esta vivo.
 */
class CircuitBreaker {
  constructor({ cooldownMs = 10000, now = () => Date.now() } = {}) {
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.circuits = new Map(); // nombre -> { openedAt, probingAt }
  }

  /** true si la peticion puede ir al servicio; false si debe responderse 503 sin intentarlo. */
  allow(name) {
    const c = this.circuits.get(name);
    if (!c) return true;
    if (this.now() - c.openedAt < this.cooldownMs) return false;
    // Ya hay una prueba en curso. Si nunca termino (el cliente corto antes de la respuesta), pasado otro plazo se
    // permite una nueva: el circuito no puede quedar abierto para siempre.
    if (c.probingAt !== null && this.now() - c.probingAt < this.cooldownMs) return false;
    c.probingAt = this.now();
    return true;
  }

  /** Segundos que faltan para volver a intentar (para Retry-After). */
  retryAfterSeconds(name) {
    const c = this.circuits.get(name);
    if (!c) return 0;
    return Math.max(1, Math.ceil((this.cooldownMs - (this.now() - c.openedAt)) / 1000));
  }

  recordFailure(name) {
    this.circuits.set(name, { openedAt: this.now(), probingAt: null });
  }

  recordSuccess(name) {
    this.circuits.delete(name);
  }

  isOpen(name) {
    return this.circuits.has(name);
  }

  /** Estado para /ready y para los logs. */
  status() {
    return Object.fromEntries([...this.circuits.keys()].map((name) => [name, "abierto"]));
  }
}

// Errores que significan "el servicio no esta" (y no "respondio mal").
const CONNECTION_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EDNSTIMEOUT", "ETIMEDOUT", "ECONNRESET"]);
const isConnectionError = (err) => Boolean(err && CONNECTION_ERRORS.has(err.code));

module.exports = { CircuitBreaker, isConnectionError };
