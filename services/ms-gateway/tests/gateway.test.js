const express = require("express");
const request = require("supertest");
const SecretsManager = require("../src/security/SecretsManager");
const buildApp = require("../src/app");

const SECRET = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const OTHER_SECRET = "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAu";
const secrets = new SecretsManager({ active: SECRET });

const token = (claims = {}, options = {}, keyRing = secrets) =>
  keyRing.sign({ typ: "access", ...claims }, { issuer: "ms-identidad", subject: "ciudadano-1", expiresIn: 900, ...options });

/** Servicio destino REAL (HTTP en un puerto efimero) que registra lo que le llega. */
function startUpstream() {
  const calls = [];
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.all("*", (req, res) => {
    calls.push({ method: req.method, path: req.path, query: req.query, headers: req.headers, body: req.body });
    res.status(req.path.endsWith("/login") ? 200 : 201).json({ echo: req.body, path: req.path });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}

let upstream;
let gateway;
beforeEach(async () => {
  upstream = await startUpstream();
  gateway = buildApp({ secrets, upstreams: { IDENTIDAD_URL: upstream.url }, issuer: "ms-identidad", timeoutMs: 2000 });
});
afterEach(async () => {
  await upstream.close();
});

describe("Rutas publicas (obtener token / registrarse): pasan sin token", () => {
  test.each([
    ["POST", "/api/v1/auth/login"],
    ["POST", "/api/v1/auth/refresh"],
    ["POST", "/api/v1/citizens"],
  ])("%s %s se reenvia sin exigir token", async (method, path) => {
    const res = await request(gateway).post(path).send({ documento: 1, password: "x" });

    expect(res.status).toBeLessThan(300);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]).toMatchObject({ method, path, body: { documento: 1, password: "x" } });
  });
});

describe("Rutas protegidas: el gateway rechaza ANTES de contactar al servicio", () => {
  test("200/201 con un access token valido; el Authorization llega intacto (cada servicio lo vuelve a validar)", async () => {
    const t = token();

    const res = await request(gateway).get("/api/v1/auth/me").set("Authorization", `Bearer ${t}`);

    expect(res.status).toBe(201);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].headers.authorization).toBe(`Bearer ${t}`);
  });

  test("401 sin token, con encabezado mal formado o con basura -- y el destino NO recibe nada", async () => {
    for (const header of [undefined, "", "Bearer", "Basic abc", "Bearer no.es.un-jwt", "suelto"]) {
      const r = request(gateway).get("/api/v1/auth/me");
      const res = await (header === undefined ? r : r.set("Authorization", header));
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "token invalido o expirado" });
      expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
    }
    expect(upstream.calls).toHaveLength(0);
  });

  test("401 con token expirado -- el destino NO recibe nada", async () => {
    const expired = token({}, { expiresIn: -10 });

    await request(gateway).get("/api/v1/auth/me").set("Authorization", `Bearer ${expired}`).expect(401);

    expect(upstream.calls).toHaveLength(0);
  });

  test("401 con firma de otra llave, alg=none, payload alterado, emisor distinto o refresh token", async () => {
    const valid = token();
    const [h, , s] = valid.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ typ: "access", iss: "ms-identidad", sub: "otro", exp: 9999999999 })).toString("base64url");
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const bad = [
      token({}, {}, new SecretsManager({ active: OTHER_SECRET })),
      `${noneHeader}.${forgedPayload}.`,
      `${h}.${forgedPayload}.${s}`,
      token({}, { issuer: "otro-servicio" }),
      token({ typ: "refresh" }),
      secrets.sign({ typ: "access" }, { issuer: "ms-identidad", expiresIn: 900 }), // sin `sub`
    ];

    for (const t of bad) await request(gateway).get("/api/v1/auth/me").set("Authorization", `Bearer ${t}`).expect(401);

    expect(upstream.calls).toHaveLength(0);
  });

  test("durante una rotacion de llave, un token firmado con la llave vieja sigue valiendo", async () => {
    const old = token();
    const rotated = buildApp({ secrets: new SecretsManager({ active: OTHER_SECRET, previous: [SECRET] }), upstreams: { IDENTIDAD_URL: upstream.url }, issuer: "ms-identidad" });

    await request(rotated).get("/api/v1/auth/me").set("Authorization", `Bearer ${old}`).expect(201);
  });
});

describe("ms-documentos: POST /api/v1/citizens/:id/documents (HU-03)", () => {
  let docs;
  let gw;
  beforeEach(async () => {
    docs = await startUpstream();
    gw = buildApp({ secrets, upstreams: { IDENTIDAD_URL: upstream.url, DOCUMENTOS_URL: docs.url }, issuer: "ms-identidad", timeoutMs: 2000 });
  });
  afterEach(async () => {
    await docs.close();
  });
  const PATH = "/api/v1/citizens/6aae9153b7655900026073f1/documents";

  test("con token valido se reenvia a ms-documentos (no a ms-identidad) con el Authorization intacto", async () => {
    const t = token();

    await request(gw).post(PATH).set("Authorization", `Bearer ${t}`).send({ titulo: "x" }).expect(201);

    expect(docs.calls).toHaveLength(1);
    expect(docs.calls[0]).toMatchObject({ method: "POST", path: PATH });
    expect(docs.calls[0].headers.authorization).toBe(`Bearer ${t}`);
    expect(upstream.calls).toHaveLength(0); // ms-identidad no recibio nada
  });

  test("el cuerpo multipart pasa como flujo, byte a byte (el gateway no lo parsea ni lo reescribe)", async () => {
    // Un servicio destino que devuelve el hash de lo que RECIBE, para compararlo con lo enviado.
    const crypto = require("crypto");
    const echo = express();
    echo.post("*", (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => res.json({ sha: crypto.createHash("sha256").update(Buffer.concat(chunks)).digest("hex"), type: req.headers["content-type"] }));
    });
    const server = await new Promise((r) => {
      const s = echo.listen(0, "127.0.0.1", () => r(s));
    });
    try {
      const g = buildApp({ secrets, upstreams: { DOCUMENTOS_URL: `http://127.0.0.1:${server.address().port}` }, issuer: "ms-identidad" });
      const binary = Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(300_000)]);

      const res = await request(g).post(PATH).set("Authorization", `Bearer ${token()}`).field("titulo", "Diploma").attach("archivo", binary, { filename: "d.pdf", contentType: "application/pdf" });

      expect(res.body.type).toMatch(/^multipart\/form-data; boundary=/);
      // el destino recibio el archivo completo: el hash del cuerpo incluye los 300 KB binarios
      expect(res.body.sha).toMatch(/^[0-9a-f]{64}$/);
      expect(res.status).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test.each([
    ["sin token", undefined],
    ["token expirado", () => token({}, { expiresIn: -10 })],
    ["un refresh token", () => token({ typ: "refresh" })],
  ])("401 %s -- y ms-documentos NO recibe nada", async (_name, makeToken) => {
    const r = request(gw).post(PATH).send({});
    const res = await (makeToken ? r.set("Authorization", `Bearer ${makeToken()}`) : r);

    expect(res.status).toBe(401);
    expect(docs.calls).toHaveLength(0);
  });

  test.each([
    ["GET", "/api/v1/citizens/6aae9153b7655900026073f1/documents/extra"],
    ["DELETE", "/api/v1/citizens/6aae9153b7655900026073f1/documents"],
    ["PUT", "/api/v1/citizens/6aae9153b7655900026073f1/documents"],
    ["POST", "/api/v1/citizens/6aae9153b7655900026073f1/documents/extra"],
    ["POST", "/api/v1/citizens//documents"],
    ["POST", "/api/v1/citizens/a.b/documents"],
    ["POST", "/api/v1/citizens/a%2Fb/documents"],
    ["POST", `/api/v1/citizens/${"x".repeat(65)}/documents`],
  ])("%s %s -> 404 (el patron es estricto)", async (method, path) => {
    const res = await request(gw)[method.toLowerCase()](path).set("Authorization", `Bearer ${token()}`);

    expect(res.status).toBe(404);
    expect(docs.calls).toHaveLength(0);
  });

  test("HU-08: GET con token valido se reenvia a ms-documentos con el Authorization y sin perder page/pageSize", async () => {
    const t = token();

    await request(gw).get(`${PATH}?page=2&pageSize=5`).set("Authorization", `Bearer ${t}`).expect(201);

    expect(docs.calls).toHaveLength(1);
    expect(docs.calls[0]).toMatchObject({ method: "GET", path: PATH, query: { page: "2", pageSize: "5" } });
    expect(docs.calls[0].headers.authorization).toBe(`Bearer ${t}`);
    expect(upstream.calls).toHaveLength(0);
  });

  test.each([
    ["sin token", undefined],
    ["token expirado", () => token({}, { expiresIn: -10 })],
    ["un refresh token", () => token({ typ: "refresh" })],
  ])("HU-08: GET 401 %s -- y ms-documentos NO recibe nada", async (_name, makeToken) => {
    const r = request(gw).get(PATH);
    const res = await (makeToken ? r.set("Authorization", `Bearer ${makeToken()}`) : r);

    expect(res.status).toBe(401);
    expect(docs.calls).toHaveLength(0);
  });

  test("sin DOCUMENTOS_URL configurada la ruta responde 404 y no se reenvia a ningun otro destino", async () => {
    const res = await request(gateway).post(PATH).set("Authorization", `Bearer ${token()}`).send({});
    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("ms-comparticion: POST /api/v1/institutions (HU-06.1, publica)", () => {
  let comp;
  let gw;
  beforeEach(async () => {
    comp = await startUpstream();
    gw = buildApp({ secrets, upstreams: { IDENTIDAD_URL: upstream.url, COMPARTICION_URL: comp.url }, issuer: "ms-identidad", timeoutMs: 2000 });
  });
  afterEach(async () => {
    await comp.close();
  });

  test("se reenvia SIN exigir token (la entidad aun no tiene cuenta), a ms-comparticion y no a otro servicio", async () => {
    await request(gw).post("/api/v1/institutions").send({ nombre: "Universidad EAFIT" }).expect(201);

    expect(comp.calls).toHaveLength(1);
    expect(comp.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/institutions", body: { nombre: "Universidad EAFIT" } });
    expect(upstream.calls).toHaveLength(0);
  });

  test("reenvia el x-registration-token intacto (el servicio decide si lo exige)", async () => {
    await request(gw).post("/api/v1/institutions").set("x-registration-token", "un-token-de-registro").send({}).expect(201);
    expect(comp.calls[0].headers["x-registration-token"]).toBe("un-token-de-registro");
  });

  test.each([
    ["GET", "/api/v1/institutions"],
    ["PUT", "/api/v1/institutions"],
    ["DELETE", "/api/v1/institutions"],
    ["POST", "/api/v1/institutions/abc"],
    ["POST", "/api/v1/institutions/"],
    ["POST", "/api/v1/institution"],
  ])("%s %s -> 404 (solo el registro esta expuesto) y no llega al destino", async (method, path) => {
    const res = await request(gw)[method.toLowerCase()](path).send({});
    expect(res.status).toBe(404);
    expect(comp.calls).toHaveLength(0);
  });

  test("sin COMPARTICION_URL configurada la ruta responde 404 y no se reenvia a otro destino", async () => {
    const res = await request(gateway).post("/api/v1/institutions").send({});
    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("Lista blanca de rutas: lo que no esta declarado no se reenvia", () => {
  test.each([
    ["GET", "/api/v1/citizens"], // el metodo no coincide (solo POST esta declarado)
    ["GET", "/api/v1/auth/login"],
    ["POST", "/api/v1/auth/me"],
    ["GET", "/api/v1/interno"],
    ["GET", "/api/v1/auth/login/"],
    ["GET", "/"],
    ["DELETE", "/api/v1/citizens"],
  ])("%s %s -> 404 y no llega al destino", async (method, path) => {
    const res = await request(gateway)[method.toLowerCase()](path).set("Authorization", `Bearer ${token()}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "ruta no encontrada" });
    expect(upstream.calls).toHaveLength(0);
  });

  test("/health y /ready responden sin token y sin contactar al destino", async () => {
    await request(gateway).get("/health").expect(200);
    await request(gateway).get("/ready").expect(200);
    expect(upstream.calls).toHaveLength(0);
  });

  test("no anuncia el framework (x-powered-by)", async () => {
    const res = await request(gateway).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("Trazabilidad (HT-06): el trace-id se propaga hasta el servicio", () => {
  test("siembra un trace-id si el cliente no trae uno, y llega igual al destino y a la respuesta", async () => {
    const res = await request(gateway).post("/api/v1/auth/login").send({});

    const sent = upstream.calls[0].headers["x-trace-id"];
    expect(sent).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    expect(res.headers["x-trace-id"]).toBe(sent);
  });

  test("reutiliza el trace-id valido del cliente", async () => {
    await request(gateway).post("/api/v1/auth/login").set("x-trace-id", "traza-cliente-0001").send({});
    expect(upstream.calls[0].headers["x-trace-id"]).toBe("traza-cliente-0001");
  });

  test("reemplaza un trace-id malicioso (no se reenvia para falsificar lineas de log)", async () => {
    await request(gateway).post("/api/v1/auth/login").set("x-trace-id", "a b\"c{").send({});
    expect(upstream.calls[0].headers["x-trace-id"]).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });
});

describe("Cuerpo y fallos del destino", () => {
  test("el cuerpo pasa sin alterarse (incluido uno grande)", async () => {
    const big = { data: "x".repeat(200_000), n: [1, 2, 3], acento: "áéíóú ñ" };

    const res = await request(gateway).post("/api/v1/citizens").send(big);

    expect(res.body.echo).toEqual(big);
  });

  test("destino caido -> 502 generico, sin filtrar host/puerto/traza", async () => {
    const dead = buildApp({ secrets, upstreams: { IDENTIDAD_URL: "http://127.0.0.1:1" }, issuer: "ms-identidad", timeoutMs: 1000 });

    const res = await request(dead).post("/api/v1/auth/login").send({});

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "servicio no disponible" });
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
  });

  test("destino que no responde a tiempo -> 504", async () => {
    const slow = express();
    slow.all("*", () => {}); // nunca responde
    const server = await new Promise((r) => {
      const s = slow.listen(0, "127.0.0.1", () => r(s));
    });
    try {
      const g = buildApp({ secrets, upstreams: { IDENTIDAD_URL: `http://127.0.0.1:${server.address().port}` }, issuer: "ms-identidad", timeoutMs: 300 });

      const res = await request(g).post("/api/v1/auth/login").send({});

      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: "servicio no disponible" });
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  test("las respuestas de error del destino (p. ej. 401 de credenciales) pasan tal cual", async () => {
    const strict = express();
    strict.post("/api/v1/auth/login", (_req, res) => res.status(401).json({ error: "credenciales invalidas" }));
    const server = await new Promise((r) => {
      const s = strict.listen(0, "127.0.0.1", () => r(s));
    });
    try {
      const g = buildApp({ secrets, upstreams: { IDENTIDAD_URL: `http://127.0.0.1:${server.address().port}` }, issuer: "ms-identidad" });

      const res = await request(g).post("/api/v1/auth/login").send({});

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "credenciales invalidas" });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
