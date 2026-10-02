const express = require("express");
const request = require("supertest");
const SecretsManager = require("../src/security/SecretsManager");
const buildApp = require("../src/app");
const { CircuitBreaker, isConnectionError } = require("../src/resilience/CircuitBreaker");
const lookupWithTimeout = require("../src/resilience/lookupWithTimeout");

const secrets = new SecretsManager({ active: "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe" });

/** Servicio destino real que cuenta las peticiones que recibe. Se puede apagar y volver a encender en el MISMO puerto. */
async function startUpstream(port = 0) {
  const calls = [];
  const app = express();
  app.all("*", (req, res) => {
    calls.push(req.path);
    res.status(200).json({ ok: true });
  });
  const server = await new Promise((r) => {
    const s = app.listen(port, "127.0.0.1", () => r(s));
  });
  return { calls, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

describe("CircuitBreaker", () => {
  test("cerrado deja pasar; un fallo lo abre y durante el plazo NO deja pasar", () => {
    let t = 0;
    const cb = new CircuitBreaker({ cooldownMs: 10000, now: () => t });
    expect(cb.allow("A")).toBe(true);
    cb.recordFailure("A");
    expect(cb.allow("A")).toBe(false);
    t = 9999;
    expect(cb.allow("A")).toBe(false);
    expect(cb.allow("B")).toBe(true); // cada servicio tiene su propio circuito
  });

  test("pasado el plazo deja pasar UNA prueba; si responde, se cierra", () => {
    let t = 0;
    const cb = new CircuitBreaker({ cooldownMs: 10000, now: () => t });
    cb.recordFailure("A");
    t = 10000;
    expect(cb.allow("A")).toBe(true); // la prueba
    expect(cb.allow("A")).toBe(false); // las demas esperan a la prueba
    cb.recordSuccess("A");
    expect(cb.allow("A")).toBe(true);
    expect(cb.isOpen("A")).toBe(false);
  });

  test("si la prueba falla se abre otra vez por un plazo completo", () => {
    let t = 0;
    const cb = new CircuitBreaker({ cooldownMs: 10000, now: () => t });
    cb.recordFailure("A");
    t = 10000;
    cb.allow("A");
    cb.recordFailure("A");
    t = 15000;
    expect(cb.allow("A")).toBe(false);
    t = 20000;
    expect(cb.allow("A")).toBe(true);
  });

  test("una prueba que nunca termina no deja el circuito abierto para siempre", () => {
    let t = 0;
    const cb = new CircuitBreaker({ cooldownMs: 10000, now: () => t });
    cb.recordFailure("A");
    t = 10000;
    expect(cb.allow("A")).toBe(true); // prueba que se pierde (el cliente corto)
    t = 15000;
    expect(cb.allow("A")).toBe(false);
    t = 20000;
    expect(cb.allow("A")).toBe(true); // nueva prueba
  });

  test("Retry-After en segundos, nunca 0 mientras este abierto", () => {
    let t = 0;
    const cb = new CircuitBreaker({ cooldownMs: 10000, now: () => t });
    cb.recordFailure("A");
    t = 2500;
    expect(cb.retryAfterSeconds("A")).toBe(8);
    t = 9999;
    expect(cb.retryAfterSeconds("A")).toBe(1);
  });

  test("solo los fallos de CONEXION cuentan (el servicio no esta), no cualquier error", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EDNSTIMEOUT", "ETIMEDOUT"]) expect(isConnectionError({ code })).toBe(true);
    expect(isConnectionError({ code: "ERR_SOMETHING" })).toBe(false);
    expect(isConnectionError(null)).toBe(false);
  });
});

describe("lookupWithTimeout: un DNS que no contesta no deja colgado al cliente", () => {
  test("si el DNS no responde en el plazo, falla con EDNSTIMEOUT", async () => {
    const lookup = lookupWithTimeout(50, () => {}); // nunca llama al callback
    const err = await new Promise((r) => lookup("ms-documentos", {}, (e) => r(e)));
    expect(err.code).toBe("EDNSTIMEOUT");
  });

  test("si responde a tiempo, pasa la respuesta tal cual (una sola vez)", async () => {
    const cb = jest.fn();
    const lookup = lookupWithTimeout(200, (_h, _o, done) => done(null, "10.0.0.5", 4));
    lookup("ms-documentos", {}, cb);
    await new Promise((r) => setTimeout(r, 300));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(null, "10.0.0.5", 4);
  });

  test("acepta la forma sin opciones lookup(host, callback)", async () => {
    const lookup = lookupWithTimeout(200, (_h, _o, done) => done(null, "10.0.0.5", 4));
    const addr = await new Promise((r) => lookup("x", (_e, a) => r(a)));
    expect(addr).toBe("10.0.0.5");
  });
});

describe("Gateway con un servicio CAIDO: falla rapido y se recupera solo", () => {

  test("DNS colgado (contenedor borrado): responde en ~el plazo del DNS, no en 20 s", async () => {
    // El destino EXISTE en localhost, pero el DNS (inyectado) nunca contesta: el gateway debe usar SU resolucion con
    // plazo y fallar a tiempo, no la resolucion normal.
    const up = await startUpstream();
    try {
      const hang = () => {};
      const g = buildApp({ secrets, upstreams: { IDENTIDAD_URL: `http://localhost:${up.port}` }, issuer: "ms-identidad", dnsTimeoutMs: 200, lookup: hang });

      const t0 = Date.now();
      const res = await request(g).post("/api/v1/auth/login").send({});

      expect(res.status).toBe(502);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(up.calls).toHaveLength(0);
    } finally {
      await up.close();
    }
  });

  test("tras el primer fallo, las siguientes peticiones reciben 503 INMEDIATO con Retry-After, sin intentar contactarlo", async () => {
    const up = await startUpstream();
    const port = up.port;
    await up.close(); // el servicio "se borra"
    const g = buildApp({ secrets, upstreams: { IDENTIDAD_URL: `http://127.0.0.1:${port}` }, issuer: "ms-identidad", circuitCooldownMs: 60000 });

    expect((await request(g).post("/api/v1/auth/login").send({})).status).toBe(502); // detecta la caida
    const t0 = Date.now();
    const res = await request(g).post("/api/v1/auth/login").send({});

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "servicio no disponible temporalmente" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(200);
    expect((await request(g).get("/ready")).body.circuitosAbiertos).toEqual({ IDENTIDAD_URL: "abierto" });
  });

  test("un servicio caido NO afecta a los demas: su circuito es independiente", async () => {
    const docs = await startUpstream();
    const g = buildApp({ secrets, upstreams: { IDENTIDAD_URL: "http://127.0.0.1:1", DOCUMENTOS_URL: `http://127.0.0.1:${docs.port}` }, issuer: "ms-identidad", circuitCooldownMs: 60000 });
    const t = secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: "6aae9153b7655900026073f1", expiresIn: 600 });
    try {
      await request(g).post("/api/v1/auth/login").send({});
      expect((await request(g).post("/api/v1/auth/login").send({})).status).toBe(503);

      const res = await request(g).get("/api/v1/citizens/6aae9153b7655900026073f1/documents").set("Authorization", `Bearer ${t}`);
      expect(res.status).toBe(200);
    } finally {
      await docs.close();
    }
  });

  test("cuando el servicio VUELVE, la prueba del semiabierto pasa y el circuito se cierra", async () => {
    const first = await startUpstream();
    const port = first.port;
    await first.close();
    const g = buildApp({ secrets, upstreams: { IDENTIDAD_URL: `http://127.0.0.1:${port}` }, issuer: "ms-identidad", circuitCooldownMs: 150 });

    await request(g).post("/api/v1/auth/login").send({}); // abre el circuito
    const back = await startUpstream(port); // el servicio vuelve en el mismo puerto
    try {
      await new Promise((r) => setTimeout(r, 200)); // pasa el plazo
      expect((await request(g).post("/api/v1/auth/login").send({})).status).toBe(200); // prueba
      expect((await request(g).post("/api/v1/auth/login").send({})).status).toBe(200); // cerrado
      expect((await request(g).get("/ready")).body.circuitosAbiertos).toEqual({});
    } finally {
      await back.close();
    }
  });

  test("un 500 del servicio NO abre el circuito (respondio: esta vivo)", async () => {
    const app = express();
    app.all("*", (_req, res) => res.status(500).json({ error: "x" }));
    const server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    try {
      const g = buildApp({ secrets, upstreams: { IDENTIDAD_URL: `http://127.0.0.1:${server.address().port}` }, issuer: "ms-identidad" });
      expect((await request(g).post("/api/v1/auth/login").send({})).status).toBe(500);
      expect((await request(g).post("/api/v1/auth/login").send({})).status).toBe(500);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("connectTimeoutAgent: una conexion que nunca se completa se aborta a tiempo", () => {
  const { EventEmitter } = require("events");
  const connectTimeoutAgent = require("../src/resilience/connectTimeoutAgent");
  class FakeAgent {
    createConnection() {
      const socket = new EventEmitter();
      socket.destroy = jest.fn();
      this.last = socket;
      return socket;
    }
  }

  test("si no conecta en el plazo, destruye el socket con ETIMEDOUT (lo que abre el cortacircuitos)", async () => {
    const agent = connectTimeoutAgent(FakeAgent, {}, 50);
    agent.createConnection({});
    await new Promise((r) => setTimeout(r, 120));
    expect(agent.last.destroy).toHaveBeenCalledTimes(1);
    expect(agent.last.destroy.mock.calls[0][0].code).toBe("ETIMEDOUT");
  });

  test("si conecta a tiempo, no hace nada (el plazo no corta peticiones lentas ya conectadas)", async () => {
    const agent = connectTimeoutAgent(FakeAgent, {}, 50);
    agent.createConnection({});
    agent.last.emit("connect");
    await new Promise((r) => setTimeout(r, 120));
    expect(agent.last.destroy).not.toHaveBeenCalled();
  });

});
