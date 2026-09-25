/**
 * HU-07.2 de extremo a extremo: POST/GET /api/v1/cases, GET /api/v1/cases/:id, PATCH /api/v1/cases/:id/status.
 *
 * Cadena real: requireEntityAuth (401) -> controlador -> PqrsCaseService (ownership, validacion) -> Mongo.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const PqrsCase = require("../src/domain/PqrsCase");
const AuditEntry = require("../src/domain/AuditEntry");
const SecretsManager = require("../src/security/SecretsManager");
const { PqrsCaseRepository } = require("../src/infrastructure/PqrsCaseRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const { PqrsCaseService } = require("../src/application/PqrsCaseService");

const ENTITY_SECRET = "Rk3pL8bN2vXq6tZ4mC9sHd1jF7gW5yAu"; // 32 caracteres, solo de prueba
const entitySecrets = new SecretsManager({ active: ENTITY_SECRET });

const EAFIT = "6aae9153b7655900026073f1";
const ICESI = "6aae9153b7655900026073f2";
const PATH = "/api/v1/cases";

let mongoServer;
let app;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});
beforeEach(async () => {
  await Promise.all([PqrsCase.createIndexes(), AuditEntry.createIndexes()]);
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const pqrsCaseService = new PqrsCaseService({ pqrsCaseRepository: new PqrsCaseRepository(), auditLogger });
  app = buildApp({ pqrsCaseService, entitySecrets, entityIssuer: "ms-comparticion" });
});

/** Token institucional tal como lo emite ms-comparticion (ADR-07). */
const entityToken = (institutionId = EAFIT, options = {}) =>
  entitySecrets.sign({ typ: "access", act: "entidad", ver: true }, { issuer: "ms-comparticion", subject: institutionId, expiresIn: 900, ...options });

const CASE_BODY = { type: "queja", subject: "Demora en respuesta", description: "El caso lleva 10 dias sin respuesta del operador." };

const crearCaso = (token = entityToken(), body = CASE_BODY) => request(app).post(PATH).set("Authorization", `Bearer ${token}`).send(body);

describe("Crear un caso (POST /cases)", () => {
  test("201 con el caso creado, estado inicial 'abierto' y la institucion sale del token, no del cuerpo", async () => {
    const res = await crearCaso(entityToken(EAFIT), { ...CASE_BODY, institutionId: ICESI }).expect(201);

    expect(res.body).toMatchObject({
      id: expect.any(String),
      institutionId: EAFIT, // el institutionId del cuerpo se ignora
      type: "queja",
      subject: "Demora en respuesta",
      status: "abierto",
      documentId: null,
    });
    expect(await PqrsCase.countDocuments({ institutionId: EAFIT })).toBe(1);
  });

  test("acepta un documentId opcional con formato de ObjectId de Mongo", async () => {
    const documentId = "665f1c04c9de9c4c34f6b52a";
    const res = await crearCaso(entityToken(), { ...CASE_BODY, documentId }).expect(201);
    expect(res.body.documentId).toBe(documentId);
  });

  test("401 sin token, con token expirado o de otro emisor -- y no se crea nada", async () => {
    const malos = [null, entityToken(EAFIT, { expiresIn: -10 }), entityToken(EAFIT, { issuer: "ms-identidad" })];
    for (const token of malos) {
      const req = request(app).post(PATH).send(CASE_BODY);
      const res = await (token ? req.set("Authorization", `Bearer ${token}`) : req);
      expect(res.status).toBe(401);
    }
    expect(await PqrsCase.countDocuments()).toBe(0);
  });

  test.each([
    ["sin type", { type: undefined }],
    ["type invalido", { type: "no-existe" }],
    ["sin subject", { subject: undefined }],
    ["subject vacio", { subject: "   " }],
    ["sin description", { description: undefined }],
    ["documentId con formato invalido", { documentId: "no-es-un-objectid" }],
  ])("400 %s, y no se crea nada", async (_name, overrides) => {
    const res = await crearCaso(entityToken(), { ...CASE_BODY, ...overrides });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("datos invalidos");
    expect(await PqrsCase.countDocuments()).toBe(0);
  });

  test("la creacion queda auditada", async () => {
    const res = await crearCaso().expect(201);
    expect(await AuditEntry.findOne({ action: "pqrs.crear", outcome: "exito" }).lean()).toMatchObject({
      actor: EAFIT,
      actorType: "entidad",
      resource: `pqrs:${res.body.id}`,
      resourceOwner: EAFIT,
    });
  });
});

describe("Listar y consultar (GET /cases, GET /cases/:id)", () => {
  test("lista solo los casos de la institucion autenticada, nunca los de otra", async () => {
    await crearCaso(entityToken(EAFIT), { ...CASE_BODY, subject: "Caso de EAFIT" }).expect(201);
    await crearCaso(entityToken(ICESI), { ...CASE_BODY, subject: "Caso de ICESI" }).expect(201);

    const res = await request(app).get(PATH).set("Authorization", `Bearer ${entityToken(EAFIT)}`).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.casos).toHaveLength(1);
    expect(res.body.casos[0]).toMatchObject({ institutionId: EAFIT, subject: "Caso de EAFIT" });
  });

  test("401 al listar sin token", async () => {
    await request(app).get(PATH).expect(401);
  });

  test("una institucion puede consultar su propio caso por id", async () => {
    const creado = await crearCaso(entityToken(EAFIT)).expect(201);

    const res = await request(app).get(`${PATH}/${creado.body.id}`).set("Authorization", `Bearer ${entityToken(EAFIT)}`).expect(200);

    expect(res.body).toMatchObject({ id: creado.body.id, institutionId: EAFIT });
  });

  test("404 si otra institucion intenta consultar un caso ajeno (no revela que exista)", async () => {
    const creado = await crearCaso(entityToken(EAFIT)).expect(201);

    const res = await request(app).get(`${PATH}/${creado.body.id}`).set("Authorization", `Bearer ${entityToken(ICESI)}`);

    expect(res.status).toBe(404);
  });

  test("404 si el caso no existe; 400 si el id no tiene formato valido", async () => {
    await request(app).get(`${PATH}/665f1c04c9de9c4c34f6b52a`).set("Authorization", `Bearer ${entityToken()}`).expect(404);
    await request(app).get(`${PATH}/no-es-un-id`).set("Authorization", `Bearer ${entityToken()}`).expect(400);
  });
});

describe("Cambiar el estado (PATCH /cases/:id/status)", () => {
  test("actualiza el estado correctamente y queda auditado con el estado anterior y el nuevo", async () => {
    const creado = await crearCaso(entityToken(EAFIT)).expect(201);

    const res = await request(app)
      .patch(`${PATH}/${creado.body.id}/status`)
      .set("Authorization", `Bearer ${entityToken(EAFIT)}`)
      .send({ status: "en_proceso" })
      .expect(200);

    expect(res.body.status).toBe("en_proceso");
    expect((await PqrsCase.findById(creado.body.id).lean()).status).toBe("en_proceso");
    expect(await AuditEntry.findOne({ action: "pqrs.cambiar_estado", outcome: "exito" }).lean()).toMatchObject({
      actor: EAFIT,
      resource: `pqrs:${creado.body.id}`,
      metadata: { from: "abierto", to: "en_proceso" },
    });
  });

  test("400 con un estado invalido, y no modifica el caso", async () => {
    const creado = await crearCaso(entityToken(EAFIT)).expect(201);

    const res = await request(app)
      .patch(`${PATH}/${creado.body.id}/status`)
      .set("Authorization", `Bearer ${entityToken(EAFIT)}`)
      .send({ status: "no-existe" });

    expect(res.status).toBe(400);
    expect((await PqrsCase.findById(creado.body.id).lean()).status).toBe("abierto");
  });

  test("404 si otra institucion intenta cambiar el estado de un caso ajeno, y no lo modifica", async () => {
    const creado = await crearCaso(entityToken(EAFIT)).expect(201);

    const res = await request(app)
      .patch(`${PATH}/${creado.body.id}/status`)
      .set("Authorization", `Bearer ${entityToken(ICESI)}`)
      .send({ status: "cerrado" });

    expect(res.status).toBe(404);
    expect((await PqrsCase.findById(creado.body.id).lean()).status).toBe("abierto");
  });
});
