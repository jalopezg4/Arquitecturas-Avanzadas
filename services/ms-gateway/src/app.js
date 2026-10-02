const http = require("http");
const https = require("https");
const { CircuitBreaker, isConnectionError } = require("./resilience/CircuitBreaker");
const lookupWithTimeout = require("./resilience/lookupWithTimeout");
const connectTimeoutAgent = require("./resilience/connectTimeoutAgent");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const logger = require("./tracing/logger");
const requireAuth = require("./security/requireAuth");
const requireEntityAuth = require("./security/requireEntityAuth");
const { ROUTES, findRoute } = require("./routes");

/** Cuerpo de error cuando el servicio destino no responde: no se filtran detalles internos (host, puerto, traza). */
function upstreamError(err, req, res) {
  logger.error("gateway.upstream_error", { err, path: req.path });
  if (!res || res.headersSent || typeof res.writeHead !== "function") return;
  const timeout = err && (err.code === "ETIMEDOUT" || err.code === "ECONNRESET" || err.code === "UND_ERR_HEADERS_TIMEOUT");
  res.writeHead(timeout ? 504 : 502, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "servicio no disponible" }));
}

/**
 * Gateway (ADR-06, HU-02): unico punto de entrada. Para cada peticion:
 *   1. asigna/propaga el trace-id (HT-06),
 *   2. busca la ruta en la lista blanca (si no esta: 404, nunca se reenvia),
 *   3. si la ruta no es publica, exige un access token valido ANTES de contactar al servicio destino,
 *      y del TIPO que esa ruta pide: ciudadano por defecto, institucional si dice `actor: "entidad"` (ADR-07),
 *   4. reenvia la peticion (con el Authorization intacto: cada microservicio VUELVE a validar el token).
 * El gateway es la primera barrera, no la unica.
 *
 * `entitySecrets` (llavero de ENTITY_JWT_SECRET) es OPCIONAL: sin el, las rutas de entidad responden 401
 * (fallan cerrado) y las de ciudadano siguen funcionando igual. Las dos llaves son distintas a proposito, asi
 * que un token de ciudadano nunca abre una ruta de entidad ni al reves.
 */
function buildApp({ secrets, entitySecrets, upstreams, issuer, entityIssuer, timeoutMs = 10000, routes = ROUTES, circuitCooldownMs = 10000, dnsTimeoutMs = 2000, connectTimeoutMs = 2000, lookup, breaker = new CircuitBreaker({ cooldownMs: circuitCooldownMs }) }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  // El gateway esta listo aunque algun servicio no lo este (la matriz de degradacion lo exige); informa cuales tienen
  // el circuito abierto para que se vea en la operacion.
  app.get("/ready", (_req, res) => res.status(200).json({ status: "ready", circuitosAbiertos: breaker.status() }));

  // NO se usa express.json(): el cuerpo pasa como flujo hacia el servicio destino, sin parsearlo ni reescribirlo.
  const proxies = {};
  // HT-03: el proxy hacia ms-documentos desactiva keep-alive (agente propio, sin reutilizar el global) para
  // que cada peticion dispare una resolucion DNS nueva y aproveche el reparto round-robin de Docker cuando
  // el servicio esta escalado a varias replicas. Los demas upstreams no cambian: siguen con el agente por
  // defecto, porque hoy corren como una sola instancia.
  // Cada destino tiene su agente con plazos acotados de DNS y de CONEXION: sin ellos, un servicio caido dejaba al
  // cliente ~24 s esperando (medido con Docker) antes de recibir el error.
  const dnsLookup = lookupWithTimeout(dnsTimeoutMs, lookup);
  for (const [name, target] of Object.entries(upstreams)) {
    const Agent = String(target).startsWith("https:") ? https.Agent : http.Agent;
    const agent = connectTimeoutAgent(Agent, { keepAlive: name !== "DOCUMENTOS_URL", lookup: dnsLookup }, connectTimeoutMs);
    proxies[name] = createProxyMiddleware({
      target,
      changeOrigin: false,
      proxyTimeout: timeoutMs, // solo el plazo del DESTINO: `timeout` cortaria la conexion del cliente sin darle un 504
      agent,
      on: {
        error: (err, req, res) => {
          if (isConnectionError(err)) {
            if (!breaker.isOpen(name)) logger.warn("gateway.circuito_abierto", { upstream: name, code: err.code });
            breaker.recordFailure(name);
          }
          upstreamError(err, req, res);
        },
        // Cualquier respuesta del destino (incluso un 500) demuestra que esta vivo: se cierra el circuito.
        proxyRes: () => {
          if (breaker.isOpen(name)) logger.info("gateway.circuito_cerrado", { upstream: name });
          breaker.recordSuccess(name);
        },
      },
    });
  }
  // Servicio con el circuito abierto: 503 inmediato, sin intentar contactarlo (fallar rapido).
  const guarded = (name) => (req, res, next) => {
    if (breaker.allow(name)) return proxies[name](req, res, next);
    res.set("Retry-After", String(breaker.retryAfterSeconds(name)));
    return res.status(503).json({ error: "servicio no disponible temporalmente" });
  };
  const authenticate = requireAuth(secrets, { issuer });
  const authenticateEntity = requireEntityAuth(entitySecrets, entityIssuer ? { issuer: entityIssuer } : undefined);

  app.use((req, res, next) => {
    const route = findRoute(req.method, req.path, routes);
    const proxy = route && proxies[route.upstream] && guarded(route.upstream);
    if (!proxy) return res.status(404).json({ error: "ruta no encontrada" });
    if (route.public) return proxy(req, res, next);
    // El tipo de actor lo decide la RUTA, no el token: un token no puede elegir por donde entrar.
    const guard = route.actor === "entidad" ? authenticateEntity : authenticate;
    return guard(req, res, () => proxy(req, res, next));
  });

  return app;
}

module.exports = buildApp;
