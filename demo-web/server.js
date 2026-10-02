// Cliente web de demostracion: sirve la pagina, reenvia /api/* al gateway (mismo origen, sin CORS) y expone un panel
// de resiliencia (/demo/*) que apaga, enciende o borra contenedores del docker compose para probar la matriz de
// degradacion en vivo. SOLO para la demo local: escucha en 127.0.0.1 y solo acepta servicios del propio compose.
// Uso: node demo-web/server.js   (GATEWAY_URL por defecto http://localhost:3000, puerto DEMO_PORT o 5173)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const GATEWAY = new URL(process.env.GATEWAY_URL || "http://localhost:3000");
const PORT = Number(process.env.DEMO_PORT || 5173);
const PAGE = path.join(__dirname, "public", "index.html");
const ROOT = path.join(__dirname, ".."); // donde esta docker-compose.yml (y el .env local)

function docker(args) {
  return new Promise((resolve) => {
    execFile("docker", args, { cwd: ROOT, timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function compose(args) {
  return new Promise((resolve) => {
    execFile("docker", ["compose", ...args], { cwd: ROOT, timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Servicios del compose con su estado (incluye los que no tienen contenedor). */
async function servicios() {
  const [all, ps] = await Promise.all([compose(["config", "--services"]), compose(["ps", "-a", "--format", "json"])]);
  const nombres = all.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const estado = {};
  for (const line of ps.stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const c = JSON.parse(line);
      const prev = estado[c.Service];
      // con varias replicas: cuantas corren
      estado[c.Service] = { state: c.State === "running" || (prev && prev.state === "running") ? "running" : c.State, replicas: (prev ? prev.replicas : 0) + (c.State === "running" ? 1 : 0) };
    } catch {
      /* linea no JSON */
    }
  }
  return nombres.map((n) => ({ servicio: n, estado: estado[n] ? estado[n].state : "borrado", replicas: estado[n] ? estado[n].replicas : 0 }));
}

const ACCIONES = {
  apagar: (s) => ["stop", s],
  encender: (s) => ["up", "-d", "--no-deps", s], // recrea el contenedor si se borro (toma la configuracion del .env)
  borrar: (s) => ["rm", "-s", "-f", s],
  replicas3: (s) => ["up", "-d", "--no-deps", "--scale", `${s}=3`, s],
  replicas1: (s) => ["up", "-d", "--no-deps", "--scale", `${s}=1`, s],
  apagar1: () => null, // se resuelve aparte: docker stop de una sola replica
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    if (req.url.startsWith("/api/")) {
      const upstream = http.request(
        { hostname: GATEWAY.hostname, port: GATEWAY.port, path: req.url, method: req.method, headers: { ...req.headers, host: GATEWAY.host } },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        }
      );
      upstream.on("error", () => json(res, 502, { error: "el gateway no responde (¿esta corriendo docker compose?)" }));
      return req.pipe(upstream);
    }
    if (req.url === "/demo/servicios" && req.method === "GET") return json(res, 200, await servicios());
    const m = /^\/demo\/servicios\/([a-z0-9-]{1,40})\/([a-z0-9]+)$/.exec(req.url);
    if (m && req.method === "POST") {
      const [, servicio, accion] = m;
      if (!ACCIONES[accion]) return json(res, 404, { error: "accion desconocida" });
      const lista = await servicios();
      if (!lista.some((s) => s.servicio === servicio)) return json(res, 404, { error: "servicio desconocido" });
      if ((accion === "replicas3" || accion === "replicas1" || accion === "apagar1") && servicio !== "ms-documentos") return json(res, 400, { error: "solo ms-documentos se escala" });
      let r;
      if (accion === "apagar1") {
        // Apaga UNA sola replica (la primera que este corriendo): demuestra la redundancia del servicio critico.
        const ids = (await compose(["ps", "-q", servicio])).stdout.split(/\s+/).filter(Boolean);
        if (ids.length < 2) return json(res, 400, { error: "se necesitan al menos 2 replicas corriendo" });
        r = await docker(["stop", ids[0]]);
      } else {
        r = await compose(ACCIONES[accion](servicio));
      }
      return json(res, r.ok ? 200 : 500, { ok: r.ok, detalle: (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-2).join(" ") });
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return fs.createReadStream(PAGE).pipe(res);
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no encontrado");
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Demo en http://localhost:${PORT} -> gateway ${GATEWAY.origin}`));
