const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const logger = require("./tracing/logger");
const requireAuth = require("./security/requireAuth");
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
 *   4. reenvia la peticion (con el Authorization intacto: cada microservicio VUELVE a validar el token).
 * El gateway es la primera barrera, no la unica.
 */
function buildApp({ secrets, upstreams, issuer, timeoutMs = 10000, routes = ROUTES }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => res.status(200).json({ status: "ready" }));

  // NO se usa express.json(): el cuerpo pasa como flujo hacia el servicio destino, sin parsearlo ni reescribirlo.
  const proxies = {};
  for (const [name, target] of Object.entries(upstreams)) {
    proxies[name] = createProxyMiddleware({ target, changeOrigin: false, proxyTimeout: timeoutMs, // solo el plazo del DESTINO: `timeout` cortaria la conexion del cliente sin darle un 504
      on: { error: upstreamError } });
  }
  const authenticate = requireAuth(secrets, { issuer });

  app.use((req, res, next) => {
    const route = findRoute(req.method, req.path, routes);
    const proxy = route && proxies[route.upstream];
    if (!proxy) return res.status(404).json({ error: "ruta no encontrada" });
    if (route.public) return proxy(req, res, next);
    return authenticate(req, res, () => proxy(req, res, next));
  });

  return app;
}

module.exports = buildApp;
