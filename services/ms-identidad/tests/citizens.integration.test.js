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
  documento: 555666777,
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
