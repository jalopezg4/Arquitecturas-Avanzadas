/**
 * Agente HTTP(S) con plazo de CONEXION. Medido con Docker: al borrar el contenedor de un servicio, su nombre puede
 * resolverse a una direccion que no contesta y la conexion TCP tarda ~20 s en fallar; `proxyTimeout` no cubre esa
 * espera, asi que el ciudadano esperaba 24 s por un error. Con este plazo, si el servicio no acepta la conexion en
 * `connectTimeoutMs`, se aborta (ETIMEDOUT) y el cortacircuitos se abre.
 */
function connectTimeoutAgent(AgentClass, options, connectTimeoutMs = 2000) {
  const agent = new AgentClass(options);
  const createConnection = agent.createConnection.bind(agent);
  agent.createConnection = (opts, callback) => {
    const socket = createConnection(opts, callback);
    const timer = setTimeout(() => {
      socket.destroy(Object.assign(new Error(`el servicio no acepto la conexion en ${connectTimeoutMs} ms`), { code: "ETIMEDOUT" }));
    }, connectTimeoutMs);
    if (timer.unref) timer.unref();
    const clear = () => clearTimeout(timer);
    socket.once("connect", clear);
    socket.once("close", clear);
    return socket;
  };
  return agent;
}

module.exports = connectTimeoutAgent;
