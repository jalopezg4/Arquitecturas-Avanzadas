const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const EventPublisher = require("../src/infrastructure/EventPublisher");
const { CitizenSagaService } = require("../src/application/CitizenSagaService");

let mongoServer;
let app;

const validBody = {
  documento: 1555666777,
  nombre: "Ana Gomez",
  direccion: "Cra 1 # 2-3",
  correo: "ana@example.com",
  password: "Sup3rSecreta!",
};

function makeFakeGovCarpeta(overrides = {}) {
  return {
    validateCitizen: jest.fn(async () => ({ available: true })),
    registerCitizen: jest.fn(async () => {}),
    unregisterCitizen: jest.fn(async () => {}),
    ...overrides,
  };
}

function makeFakePublisher() {
  return { publish: jest.fn(async () => {}) };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120000); // primera corrida descarga el binario de Mongo (~500MB); corridas siguientes usan cache

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

function buildAppWithGovCarpeta(govCarpetaClient) {
  const citizenRepository = new CitizenRepository();
  const eventPublisher = makeFakePublisher();
  const citizenSagaService = new CitizenSagaService({ citizenRepository, govCarpetaClient, eventPublisher });
  return buildApp({ citizenSagaService });
}

describe("POST /api/v1/citizens (integracion)", () => {
  test("201 con ciudadanoId y direccionUnica cuando todo sale bien", async () => {
    app = buildAppWithGovCarpeta(makeFakeGovCarpeta());

    const res = await request(app).post("/api/v1/citizens").send(validBody);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ciudadanoId: expect.any(String), direccionUnica: expect.any(String) });
  });

  test("400 si faltan campos requeridos", async () => {
    app = buildAppWithGovCarpeta(makeFakeGovCarpeta());

    const res = await request(app).post("/api/v1/citizens").send({ ...validBody, correo: undefined });

    expect(res.status).toBe(400);
  });

  test("409 si el documento ya existe", async () => {
    app = buildAppWithGovCarpeta(makeFakeGovCarpeta());

    await request(app).post("/api/v1/citizens").send(validBody);
    const res = await request(app).post("/api/v1/citizens").send(validBody);

    expect(res.status).toBe(409);
  });

  test("409 si GovCarpeta indica que el ciudadano ya esta afiliado a otro operador", async () => {
    app = buildAppWithGovCarpeta(makeFakeGovCarpeta({ validateCitizen: jest.fn(async () => ({ available: false })) }));

    const res = await request(app).post("/api/v1/citizens").send(validBody);

    expect(res.status).toBe(409);
  });

  test("503 si GovCarpeta no responde", async () => {
    app = buildAppWithGovCarpeta(
      makeFakeGovCarpeta({
        validateCitizen: jest.fn(async () => {
          throw new Error("timeout");
        }),
      })
    );

    const res = await request(app).post("/api/v1/citizens").send(validBody);

    expect(res.status).toBe(503);
  });
});

describe("GET /health y /ready", () => {
  test("responden 200", async () => {
    app = buildAppWithGovCarpeta(makeFakeGovCarpeta());
    const health = await request(app).get("/health");
    const ready = await request(app).get("/ready");
    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
  });
});

describe("Registro rechazado o dudoso por GovCarpeta: no bloquea el documento (hallado en la prueba real)", () => {
  const Citizen = require("../src/domain/Citizen");
  const rejection = (status) => Object.assign(new Error(`registerCitizen respondio ${status}, se esperaba 201`), { response: { status } });

  test.each([[400], [404], [501]])("si GovCarpeta responde %i (rechazo definitivo) no queda un pendiente y se puede reintentar con datos corregidos", async (status) => {
    let calls = 0;
    app = buildAppWithGovCarpeta(
      makeFakeGovCarpeta({
        registerCitizen: jest.fn(async () => {
          if (++calls === 1) throw rejection(status);
        }),
      })
    );

    const first = await request(app).post("/api/v1/citizens").send(validBody);
    expect(first.status).toBe(503);
    expect(await Citizen.countDocuments()).toBe(0);

    const retry = await request(app).post("/api/v1/citizens").send(validBody);
    expect(retry.status).toBe(201);
    expect(await Citizen.countDocuments({ estado: "activo" })).toBe(1);
  });

  test.each([
    ["500", () => rejection(500)],
    ["timeout / sin respuesta", () => new Error("timeout of 5000ms exceeded")],
  ])("un fallo AMBIGUO (%s) conserva el pendiente: GovCarpeta pudo haberlo aceptado y hay que reconciliar", async (_name, makeErr) => {
    app = buildAppWithGovCarpeta(makeFakeGovCarpeta({ registerCitizen: jest.fn(async () => { throw makeErr(); }) }));

    const res = await request(app).post("/api/v1/citizens").send(validBody);

    expect(res.status).toBe(503);
    expect(await Citizen.countDocuments({ estado: "pendiente" })).toBe(1);
  });

  test("deletePending NUNCA borra a un ciudadano ya activo", async () => {
    const repo = new CitizenRepository();
    const c = await Citizen.create({ documento: 1555666777, nombre: "A", direccion: "d", correo: "a@b.co", passwordHash: "x", direccionUnica: "u@x", estado: "activo" });

    await repo.deletePending(c._id);

    expect(await Citizen.countDocuments()).toBe(1);
  });

});
