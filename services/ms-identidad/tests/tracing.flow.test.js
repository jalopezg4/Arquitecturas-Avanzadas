const request = require("supertest");

const buildApp = require("../src/app");
const { CitizenSagaService } = require("../src/application/CitizenSagaService");
const GovCarpetaClient = require("../src/infrastructure/GovCarpetaClient");
const LogAggregator = require("../src/tracing/LogAggregator");
const logger = require("../src/tracing/logger");

const body = {
  documento: 4455667788,
  nombre: "Ana Gomez",
  direccion: "Cra 1 # 2-3",
  correo: "ana@example.com",
  password: "Sup3rSecreta!",
};

function makeRepo() {
  const store = new Map();
  let seq = 0; // _id opaco, como un ObjectId de Mongo: no debe derivarse del documento
  return {
    findByDocumento: async (d) => store.get(d) || null,
    create: async (data) => {
      const c = { _id: `oid-${++seq}`, ...data };
      store.set(data.documento, c);
      return c;
    },
    markActive: async (id) => {
      const c = [...store.values()].find((x) => x._id === id);
      c.estado = "activo";
      return c;
    },
  };
}

/** Cliente GovCarpeta REAL con un `http` falso que registra que headers recibe. */
function makeGovHttp({ registerStatus = 201 } = {}) {
  const calls = [];
  return {
    calls,
    get: async (url, cfg) => {
      calls.push({ url, headers: cfg.headers });
      return { status: 204 };
    },
    post: async (url, _body, cfg) => {
      calls.push({ url, headers: cfg.headers });
      return { status: registerStatus };
    },
    delete: async () => ({ status: 201 }),
  };
}

let lines;
beforeEach(() => {
  lines = [];
  logger.setSink((l) => lines.push(l));
});
afterEach(() => logger.resetSink());

function buildFlowApp(http) {
  const saga = new CitizenSagaService({
    citizenRepository: makeRepo(),
    govCarpetaClient: new GovCarpetaClient({ baseUrl: "http://gov", operatorId: "op", operatorName: "Op", http }),
    eventPublisher: { publish: async () => {} },
  });
  return buildApp({ citizenSagaService: saga });
}

describe("trazabilidad de punta a punta en el registro (HU-01)", () => {
  test("todas las lineas de log y las llamadas a GovCarpeta comparten el mismo trace-id", async () => {
    const http = makeGovHttp();
    const res = await request(buildFlowApp(http)).post("/api/v1/citizens").set("x-trace-id", "gateway-flow-0001").send(body);

    expect(res.status).toBe(201);
    expect(res.headers["x-trace-id"]).toBe("gateway-flow-0001");

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.length).toBeGreaterThanOrEqual(5);
    for (const entry of parsed) expect(entry.traceId).toBe("gateway-flow-0001");

    // Un aviso de configuracion no debe quedar atribuido a la traza de una peticion cualquiera.
    expect(parsed.filter((e) => e.level === "warn")).toEqual([]);

    expect(http.calls).toHaveLength(2); // validateCitizen + registerCitizen
    for (const call of http.calls) expect(call.headers).toEqual({ "x-trace-id": "gateway-flow-0001" });
  });

  test("dos registros simultaneos no mezclan sus trazas", async () => {
    const app = buildFlowApp(makeGovHttp());
    const a = request(app).post("/api/v1/citizens").set("x-trace-id", "flow-aaaaaaaa").send({ ...body, documento: 1111111111 });
    const b = request(app).post("/api/v1/citizens").set("x-trace-id", "flow-bbbbbbbb").send({ ...body, documento: 2222222222 });
    await Promise.all([a, b]);

    const agg = LogAggregator.fromText(lines.join("\n"));
    expect(agg.byTraceId("flow-aaaaaaaa").length).toBeGreaterThan(0);
    expect(agg.byTraceId("flow-bbbbbbbb").length).toBeGreaterThan(0);
    // cada traza cuenta la misma historia completa, sin lineas de la otra
    expect(agg.byTraceId("flow-aaaaaaaa").map((e) => e.msg)).toEqual(agg.byTraceId("flow-bbbbbbbb").map((e) => e.msg));
  });

  test("con la traza se ve en que paso exacto fallo la saga (GovCarpeta responde 500 al registrar)", async () => {
    const res = await request(buildFlowApp(makeGovHttp({ registerStatus: 500 })))
      .post("/api/v1/citizens")
      .set("x-trace-id", "gateway-fail-0001")
      .send(body);

    expect(res.status).toBe(503);

    const agg = LogAggregator.fromText(lines.join("\n"));
    const failure = agg.firstError("gateway-fail-0001");
    expect(failure).toMatchObject({ msg: "saga.paso_fallido", step: "govcarpeta.registerCitizen" });

    const okSteps = agg.byTraceId("gateway-fail-0001").filter((e) => e.msg === "saga.paso_ok").map((e) => e.step);
    expect(okSteps).toEqual(["persistir_pendiente"]); // llego hasta persistir, y fallo al confirmar
  });

  test("los logs no contienen datos personales (documento, correo, password)", async () => {
    await request(buildFlowApp(makeGovHttp())).post("/api/v1/citizens").send(body);

    const all = lines.join("\n");
    expect(all).not.toContain(String(body.documento));
    expect(all).not.toContain(body.correo);
    expect(all).not.toContain(body.password);
  });
});
