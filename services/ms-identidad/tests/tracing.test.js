const express = require("express");
const request = require("supertest");

const { runWithTrace, getTraceId, newTraceId, isValidTraceId } = require("../src/tracing/TraceContext");
const logger = require("../src/tracing/logger");
const tracingMiddleware = require("../src/tracing/tracingMiddleware");
const LogAggregator = require("../src/tracing/LogAggregator");
const GovCarpetaClient = require("../src/infrastructure/GovCarpetaClient");
const EventPublisher = require("../src/infrastructure/EventPublisher");
const AuditLogger = require("../src/infrastructure/AuditLogger");

let lines;
beforeEach(() => {
  lines = [];
  logger.setSink((l) => lines.push(JSON.parse(l)));
});
afterEach(() => logger.resetSink());

describe("TraceContext", () => {
  test("no hay trace-id fuera de un contexto", () => {
    expect(getTraceId()).toBeUndefined();
  });

  test("el trace-id sobrevive a await y timers dentro del mismo contexto", async () => {
    await runWithTrace("trace-abc12345", async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      expect(getTraceId()).toBe("trace-abc12345");
    });
  });

  test("peticiones concurrentes no mezclan sus trace-id", async () => {
    const seen = [];
    const work = (id, delay) =>
      runWithTrace(id, async () => {
        await new Promise((r) => setTimeout(r, delay));
        seen.push([id, getTraceId()]);
      });

    await Promise.all([work("trace-aaaaaaaa", 20), work("trace-bbbbbbbb", 5), work("trace-cccccccc", 10)]);

    for (const [expected, actual] of seen) expect(actual).toBe(expected);
    expect(seen).toHaveLength(3);
  });

  test("valida el formato: rechaza saltos de linea, JSON y valores muy cortos o largos", () => {
    expect(isValidTraceId(newTraceId())).toBe(true);
    expect(isValidTraceId("abc")).toBe(false);
    expect(isValidTraceId("valido-12345\nfalso")).toBe(false);
    expect(isValidTraceId('{"level":"error"}')).toBe(false);
    expect(isValidTraceId("x".repeat(65))).toBe(false);
    expect(isValidTraceId(undefined)).toBe(false);
  });
});

describe("logger", () => {
  test("cada linea es JSON con servicio, nivel, mensaje y el trace-id del contexto", () => {
    runWithTrace("trace-log00001", () => logger.info("hola", { step: "x" }));

    expect(lines[0]).toMatchObject({
      level: "info",
      service: "ms-identidad",
      traceId: "trace-log00001",
      msg: "hola",
      step: "x",
    });
    expect(lines[0].ts).toEqual(expect.any(String));
  });

  test("serializa errores sin volcar el stack completo", () => {
    const err = Object.assign(new Error("boom"), { code: "E_X" });
    logger.error("fallo", { err });

    expect(lines[0].err).toEqual({ name: "Error", message: "boom", code: "E_X" });
  });
});

describe("TracingMiddleware", () => {
  function makeApp(downstream = jest.fn()) {
    const app = express();
    app.use(tracingMiddleware);
    app.get("/ping", (_req, res) => {
      downstream(getTraceId());
      res.json({ ok: true });
    });
    app.get("/health", (_req, res) => res.json({ ok: true }));
    return app;
  }

  test("propaga el trace-id entrante hasta el codigo del servicio y lo devuelve en la respuesta", async () => {
    const downstream = jest.fn();
    const res = await request(makeApp(downstream)).get("/ping").set("x-trace-id", "gateway-trace-001");

    expect(res.headers["x-trace-id"]).toBe("gateway-trace-001");
    expect(downstream).toHaveBeenCalledWith("gateway-trace-001");
  });

  test("genera un trace-id nuevo cuando la peticion no trae ninguno", async () => {
    const downstream = jest.fn();
    const res = await request(makeApp(downstream)).get("/ping");

    expect(isValidTraceId(res.headers["x-trace-id"])).toBe(true);
    expect(downstream).toHaveBeenCalledWith(res.headers["x-trace-id"]);
  });

  test("descarta un trace-id malicioso (intento de falsificar logs) y genera uno propio", async () => {
    const res = await request(makeApp()).get("/ping").set("x-trace-id", 'x"},"level":"error');

    expect(res.headers["x-trace-id"]).not.toContain("level");
    expect(isValidTraceId(res.headers["x-trace-id"])).toBe(true);
  });

  test("registra inicio y fin de la peticion con el mismo trace-id", async () => {
    await request(makeApp()).get("/ping").set("x-trace-id", "gateway-trace-002");

    const mine = lines.filter((l) => l.traceId === "gateway-trace-002");
    expect(mine.map((l) => l.msg)).toEqual(["request.start", "request.end"]);
    expect(mine[1].status).toBe(200);
  });

  test("no llena los logs con /health", async () => {
    await request(makeApp()).get("/health");
    expect(lines).toHaveLength(0);
  });
});

describe("propagacion hacia otros sistemas", () => {
  test("GovCarpetaClient envia el trace-id en cada llamada saliente", async () => {
    const get = jest.fn(async () => ({ status: 204 }));
    const post = jest.fn(async () => ({ status: 201 }));
    const del = jest.fn(async () => ({ status: 201 }));
    const client = new GovCarpetaClient({
      baseUrl: "http://fake",
      operatorId: "op",
      operatorName: "Op",
      http: { get, post, delete: del },
    });

    await runWithTrace("trace-out00001", async () => {
      await client.validateCitizen(1);
      await client.registerCitizen({ id: 1, name: "A", address: "B", email: "a@a.com" });
      await client.unregisterCitizen(1);
    });

    expect(get.mock.calls[0][1].headers).toEqual({ "x-trace-id": "trace-out00001" });
    expect(post.mock.calls[0][2].headers).toEqual({ "x-trace-id": "trace-out00001" });
    expect(del.mock.calls[0][1].headers).toEqual({ "x-trace-id": "trace-out00001" });
  });

  test("GovCarpetaClient no inventa header si no hay contexto de trazabilidad", async () => {
    const get = jest.fn(async () => ({ status: 204 }));
    const client = new GovCarpetaClient({ baseUrl: "http://fake", http: { get } });

    await client.validateCitizen(1);

    expect(get.mock.calls[0][1].headers).toEqual({});
  });

  test("EventPublisher incluye el trace-id en los headers del mensaje para que el consumidor lo retome", async () => {
    const publish = jest.fn((_ex, _key, _buf, _opts, cb) => cb(null));
    const publisher = new EventPublisher("amqp://fake");
    publisher.channel = { publish };

    await runWithTrace("trace-evt00001", () => publisher.publish("ciudadano.registrado", { a: 1 }));

    expect(publish.mock.calls[0][3].headers).toEqual({ "x-trace-id": "trace-evt00001" });
  });

  test("la bitacora guarda el trace-id de cada entrada", async () => {
    const create = jest.fn(async (e) => e);
    const audit = new AuditLogger({ auditRepository: { create } });

    await runWithTrace("trace-aud00001", () => audit.record({ actor: "1", action: "x", outcome: "exito" }));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ traceId: "trace-aud00001" }));
  });
});

describe("LogAggregator", () => {
  const mk = (over) =>
    JSON.stringify({ ts: "2026-09-19T10:00:00.000Z", level: "info", service: "ms-identidad", msg: "m", ...over });

  test("permite consultar todos los logs de un trace-id especifico, mezclando servicios", () => {
    const text = [
      mk({ traceId: "T1", service: "ms-gateway", ts: "2026-09-19T10:00:00.000Z", msg: "request.start" }),
      mk({ traceId: "T2", service: "ms-identidad", msg: "otra peticion" }),
      mk({ traceId: "T1", service: "ms-identidad", ts: "2026-09-19T10:00:01.000Z", msg: "saga.registro.inicio" }),
      mk({ traceId: "T1", service: "ms-notificaciones", ts: "2026-09-19T10:00:02.000Z", msg: "correo.enviado" }),
    ].join("\n");

    const agg = LogAggregator.fromText(text);

    expect(agg.byTraceId("T1").map((e) => e.msg)).toEqual(["request.start", "saga.registro.inicio", "correo.enviado"]);
    expect(agg.services("T1")).toEqual(["ms-gateway", "ms-identidad", "ms-notificaciones"]);
    expect(agg.byTraceId("T2")).toHaveLength(1);
  });

  test("ordena cronologicamente aunque las lineas lleguen desordenadas", () => {
    const text = [
      mk({ traceId: "T1", ts: "2026-09-19T10:00:05.000Z", msg: "segundo" }),
      mk({ traceId: "T1", ts: "2026-09-19T10:00:01.000Z", msg: "primero" }),
    ].join("\n");

    expect(LogAggregator.fromText(text).byTraceId("T1").map((e) => e.msg)).toEqual(["primero", "segundo"]);
  });

  test("tolera el prefijo de docker compose y lineas que no son JSON", () => {
    const text = [
      `ms-identidad-1  | ${mk({ traceId: "T1", msg: "con prefijo" })}`,
      "ms-identidad-1  | esto no es un log estructurado",
      "{json roto",
      mk({ msg: "sin traceId" }),
    ].join("\n");

    expect(LogAggregator.fromText(text).byTraceId("T1").map((e) => e.msg)).toEqual(["con prefijo"]);
  });

  test("firstError senala el paso donde fallo la peticion", () => {
    const text = [
      mk({ traceId: "T1", ts: "2026-09-19T10:00:01.000Z", msg: "saga.paso_ok", step: "persistir_pendiente" }),
      mk({
        traceId: "T1",
        ts: "2026-09-19T10:00:02.000Z",
        level: "error",
        msg: "saga.paso_fallido",
        step: "govcarpeta.registerCitizen",
      }),
    ].join("\n");

    const failure = LogAggregator.fromText(text).firstError("T1");

    expect(failure).toMatchObject({ msg: "saga.paso_fallido", step: "govcarpeta.registerCitizen" });
  });

  test("timeline devuelve una linea legible por evento", () => {
    const text = mk({ traceId: "T1", level: "error", msg: "saga.paso_fallido", step: "x" });

    expect(LogAggregator.fromText(text).timeline("T1")[0]).toBe(
      '2026-09-19T10:00:00.000Z [ms-identidad] ERROR saga.paso_fallido {"step":"x"}'
    );
  });
});
