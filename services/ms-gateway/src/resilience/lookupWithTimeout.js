const dns = require("dns");

/**
 * `lookup` para los agentes HTTP del gateway con un plazo maximo. El `proxyTimeout` solo cuenta desde que la conexion
 * esta abierta: si el contenedor de un servicio desaparece, el DNS interno de Docker reenvia la consulta hacia fuera y
 * tarda ~20 s en contestar, y el ciudadano esperaba todo ese tiempo. Con este plazo el fallo se detecta en segundos y
 * el cortacircuitos (CircuitBreaker) hace que las siguientes peticiones fallen de inmediato.
 */
function lookupWithTimeout(timeoutMs = 2000, lookup = dns.lookup) {
  return function lookupConPlazo(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      callback(Object.assign(new Error(`DNS sin respuesta para ${hostname} en ${timeoutMs} ms`), { code: "EDNSTIMEOUT" }));
    }, timeoutMs);
    lookup(hostname, options, (...args) => {
      if (done) return;
      clearTimeout(timer);
      callback(...args);
    });
  };
}

module.exports = lookupWithTimeout;
