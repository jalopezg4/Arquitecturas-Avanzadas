const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFileSync } = require("child_process");
const express = require("express");

const createServer = require("../src/transport/createServer");

// Certificados REALES generados con openssl (disponible en Linux/macOS/Git for Windows y en el CI).
let hasOpenssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  hasOpenssl = false;
}
const maybe = hasOpenssl ? describe : describe.skip;

let dir;
const p = (f) => path.join(dir, f);
const sh = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });

function makeCa(name) {
  sh("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.crt`, "-subj", `/CN=${name}`, "-days", "1");
}
function makeLeaf(name, caName, { server = false } = {}) {
  sh("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${server ? "localhost" : name}`);
  const ext = server ? "subjectAltName=DNS:localhost,IP:127.0.0.1\n" : "extendedKeyUsage=clientAuth\n";
  fs.writeFileSync(p(`${name}.ext`), ext);
  sh("x509", "-req", "-in", `${name}.csr`, "-CA", `${caName}.crt`, "-CAkey", `${caName}.key`, "-CAcreateserial", "-out", `${name}.crt`, "-days", "1", "-extfile", `${name}.ext`);
}

function request(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: "localhost", port, path: "/health", ...options }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

function listen(tls) {
  const app = express();
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  const server = createServer(app, tls);
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

beforeAll(() => {
  if (!hasOpenssl) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tls-"));
  makeCa("ca");
  makeLeaf("server", "ca", { server: true });
  makeLeaf("gateway", "ca"); // cliente legitimo (ej. ms-gateway)
  makeCa("evil-ca");
  makeLeaf("intruder", "evil-ca"); // cliente firmado por otra CA
}, 60000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("sin certificado, createServer devuelve un servidor HTTP plano (proxy/plataforma termina TLS)", () => {
  const server = createServer(express(), {});
  expect(server).toBeInstanceOf(http.Server);
  expect(server).not.toBeInstanceOf(https.Server);
  server.close();
});

test("certificado sin llave (o al reves) es un error de configuracion", () => {
  expect(() => createServer(express(), { certPath: "/x.pem" })).toThrow(/juntos/);
  expect(() => createServer(express(), { keyPath: "/x.key" })).toThrow(/juntos/);
});

maybe("TLS: el trafico va cifrado", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await listen({ certPath: p("server.crt"), keyPath: p("server.key") });
  });
  afterAll(() => ctx.server.close());

  test("un cliente que confia en la CA obtiene respuesta por HTTPS", async () => {
    const res = await request(ctx.port, { ca: fs.readFileSync(p("ca.crt")) });
    expect(res).toEqual({ status: 200, body: '{"status":"ok"}' });
  });

  test("un cliente que NO confia en el certificado rechaza la conexion", async () => {
    await expect(request(ctx.port)).rejects.toThrow(/self.signed|unable to verify|certificate/i);
  });

  test("el trafico en texto plano (HTTP) no es atendido en el puerto TLS", async () => {
    const res = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: ctx.port, path: "/health" }, (r) => resolve(`respuesta ${r.statusCode}`));
      req.on("error", () => resolve("rechazado"));
    });
    expect(res).toBe("rechazado");
  });

  test("exige TLS 1.3: un cliente limitado a TLS 1.2 es rechazado", async () => {
    await expect(request(ctx.port, { ca: fs.readFileSync(p("ca.crt")), maxVersion: "TLSv1.2" })).rejects.toThrow();
  });
});

maybe("mTLS: entre servicios se exige certificado de cliente", () => {
  let ctx;
  const trust = () => fs.readFileSync(p("ca.crt"));
  beforeAll(async () => {
    ctx = await listen({ certPath: p("server.crt"), keyPath: p("server.key"), caPath: p("ca.crt") });
  });
  afterAll(() => ctx.server.close());

  test("un cliente con certificado firmado por la CA (ej. ms-gateway) es atendido", async () => {
    const res = await request(ctx.port, { ca: trust(), cert: fs.readFileSync(p("gateway.crt")), key: fs.readFileSync(p("gateway.key")) });
    expect(res.status).toBe(200);
  });

  test("un cliente sin certificado es rechazado", async () => {
    await expect(request(ctx.port, { ca: trust() })).rejects.toThrow();
  });

  test("un cliente con certificado de OTRA CA (intruso) es rechazado", async () => {
    await expect(
      request(ctx.port, { ca: trust(), cert: fs.readFileSync(p("intruder.crt")), key: fs.readFileSync(p("intruder.key")) })
    ).rejects.toThrow();
  });
});
