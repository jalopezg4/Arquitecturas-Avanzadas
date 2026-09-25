/**
 * HU-07.3 (implementacion PARCIAL, RFP-02) de extremo a extremo: POST/GET /api/v1/document-requests,
 * GET /api/v1/document-requests/:id.
 *
 * Cadena real: requireEntityAuth (401) -> controlador -> DocumentRequestService (ownership, validacion) -> Mongo.
 * Solo un registro local: NO hay cliente HTTP hacia ms-interoperabilidad en este servicio (no hay nada que
 * mockear), asi que estos tests usan Repository/Service/Controller reales de punta a punta.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const DocumentRequest = require("../src/domain/DocumentRequest");
const SecretsManager = require("../src/security/SecretsManager");
const { DocumentRequestRepository } = require("../src/infrastructure/DocumentRequestRepository");
const { DocumentRequestService } = require("../src/application/DocumentRequestService");

const ENTITY_SECRET = "Rk3pL8bN2vXq6tZ4mC9sHd1jF7gW5yAu"; // 32 caracteres, solo de prueba
const entitySecrets = new SecretsManager({ active: ENTITY_SECRET });

const EAFIT = "6aae9153b7655900026073f1";
const ICESI = "6aae9153b7655900026073f2";
const PATH = "/api/v1/document-requests";

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
  await DocumentRequest.createIndexes(); // dropDatabase() borra los indices
  const documentRequestService = new DocumentRequestService({ documentRequestRepository: new DocumentRequestRepository() });
  app = buildApp({ documentRequestService, entitySecrets, entityIssuer: "ms-comparticion" });
});

const entityToken = (institutionId = EAFIT, options = {}) =>
  entitySecrets.sign({ typ: "access", act: "entidad", ver: true }, { issuer: "ms-comparticion", subject: institutionId, expiresIn: 900, ...options });

const REQUEST_BODY = { direccionUnica: "1000000001-3f9c2ab7@carpetacolombia.co", descripcion: "Solicitar copia del certificado de estudios" };

const crear = (token = entityToken(), body = REQUEST_BODY) => request(app).post(PATH).set("Authorization", `Bearer ${token}`).send(body);

describe("Crear una solicitud (POST /document-requests)", () => {
  test("201 con la solicitud creada, estado inicial 'registrada'", async () => {
    const res = await crear().expect(201);

    expect(res.body).toMatchObject({
      id: expect.any(String),
      institutionId: EAFIT,
      direccionUnica: REQUEST_BODY.direccionUnica,
      descripcion: REQUEST_BODY.descripcion,
      operadorDestinoId: null,
      estado: "registrada",
    });
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.updatedAt).toBeDefined();
    expect(await DocumentRequest.countDocuments({ institutionId: EAFIT })).toBe(1);
  });

  test("la institucion SIEMPRE sale del token, nunca del cuerpo (un institutionId falso en el body se ignora)", async () => {
    const res = await crear(entityToken(EAFIT), { ...REQUEST_BODY, institutionId: ICESI }).expect(201);

    expect(res.body.institutionId).toBe(EAFIT);
    expect(await DocumentRequest.countDocuments({ institutionId: ICESI })).toBe(0);
  });

  test("acepta la creacion sin operadorDestinoId", async () => {
    const res = await crear().expect(201);
    expect(res.body.operadorDestinoId).toBeNull();
  });

  test("acepta y guarda operadorDestinoId tal cual, SIN validarlo contra ningun directorio (no hay llamada a ms-interoperabilidad)", async () => {
    // Un id con formato valido pero que no corresponde a ningun operador real: si el servicio lo validara contra
    // un directorio, esto fallaria. Se acepta porque esta version SOLO registra lo que la institucion declara.
    const res = await crear(entityToken(), { ...REQUEST_BODY, operadorDestinoId: "operador-inventado-999" }).expect(201);

    expect(res.body.operadorDestinoId).toBe("operador-inventado-999");
    expect((await DocumentRequest.findById(res.body.id).lean()).operadorDestinoId).toBe("operador-inventado-999");
  });

  test("el estado inicial es SIEMPRE 'registrada'; un estado arbitrario enviado por el cliente se ignora", async () => {
    const res = await crear(entityToken(), { ...REQUEST_BODY, estado: "transferida" }).expect(201);

    expect(res.body.estado).toBe("registrada");
    expect((await DocumentRequest.findById(res.body.id).lean()).estado).toBe("registrada");
  });

  test("401 sin token, con token expirado o de otro emisor -- y no se crea nada", async () => {
    const malos = [null, entityToken(EAFIT, { expiresIn: -10 }), entityToken(EAFIT, { issuer: "ms-identidad" })];
    for (const token of malos) {
      const req = request(app).post(PATH).send(REQUEST_BODY);
      const res = await (token ? req.set("Authorization", `Bearer ${token}`) : req);
      expect(res.status).toBe(401);
    }
    expect(await DocumentRequest.countDocuments()).toBe(0);
  });

  test.each([
    ["sin direccionUnica", { direccionUnica: undefined }],
    ["direccionUnica vacia", { direccionUnica: "   " }],
    ["direccionUnica con formato invalido", { direccionUnica: "no-es-un-correo" }],
    ["sin descripcion", { descripcion: undefined }],
    ["descripcion vacia", { descripcion: "   " }],
    ["operadorDestinoId con formato invalido", { operadorDestinoId: "operador con espacios" }],
  ])("400 %s, y no se crea nada", async (_name, overrides) => {
    const res = await crear(entityToken(), { ...REQUEST_BODY, ...overrides });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("datos invalidos");
    expect(await DocumentRequest.countDocuments()).toBe(0);
  });
});

describe("Listar y consultar (GET /document-requests, GET /document-requests/:id)", () => {
  test("lista solo las solicitudes de la institucion autenticada, nunca las de otra", async () => {
    await crear(entityToken(EAFIT), { ...REQUEST_BODY, descripcion: "Solicitud de EAFIT" }).expect(201);
    await crear(entityToken(ICESI), { ...REQUEST_BODY, descripcion: "Solicitud de ICESI" }).expect(201);

    const res = await request(app).get(PATH).set("Authorization", `Bearer ${entityToken(EAFIT)}`).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.solicitudes).toHaveLength(1);
    expect(res.body.solicitudes[0]).toMatchObject({ institutionId: EAFIT, descripcion: "Solicitud de EAFIT" });
  });

  test("401 al listar sin token", async () => {
    await request(app).get(PATH).expect(401);
  });

  test("una institucion puede consultar su propia solicitud por id", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);

    const res = await request(app).get(`${PATH}/${creada.body.id}`).set("Authorization", `Bearer ${entityToken(EAFIT)}`).expect(200);

    expect(res.body).toMatchObject({ id: creada.body.id, institutionId: EAFIT });
  });

  test("404 si otra institucion intenta consultar una solicitud ajena (no revela que exista)", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);

    const res = await request(app).get(`${PATH}/${creada.body.id}`).set("Authorization", `Bearer ${entityToken(ICESI)}`);

    expect(res.status).toBe(404);
  });

  test("404 si la solicitud no existe; 400 si el id no tiene formato valido", async () => {
    await request(app).get(`${PATH}/665f1c04c9de9c4c34f6b52a`).set("Authorization", `Bearer ${entityToken()}`).expect(404);
    await request(app).get(`${PATH}/no-es-un-id`).set("Authorization", `Bearer ${entityToken()}`).expect(400);
  });
});

describe("Contrato de la respuesta", () => {
  test("no contiene ciudadanoId ni ningun dato de transferencia/consentimiento inventado", async () => {
    const res = await crear(entityToken(), { ...REQUEST_BODY, operadorDestinoId: "operador-123" }).expect(201);

    const json = JSON.stringify(res.body);
    for (const prohibido of ["ciudadanoId", "premium", "plan", "consentimiento", "transferencia", "enviada", "autorizada", "transferida", "storageKey"]) {
      expect(json).not.toContain(prohibido);
    }
    expect(Object.keys(res.body).sort()).toEqual(["createdAt", "descripcion", "direccionUnica", "estado", "id", "institutionId", "operadorDestinoId", "updatedAt"]);
  });
});
