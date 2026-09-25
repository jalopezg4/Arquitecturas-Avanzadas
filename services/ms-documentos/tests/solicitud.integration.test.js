/**
 * HU-06.3 de extremo a extremo dentro de ms-documentos.
 *
 * PASO 1 (institucional): POST/GET /api/v1/document-requests, GET /api/v1/document-requests/:id.
 * Cadena real: requireEntityAuth (401) -> requireVerifiedEntity (403) -> SolicitudService (resolucion del
 * ciudadano via Folder, validacion, ownership) -> Mongo.
 *
 * PASO 2 (ciudadano): GET /api/v1/citizens/me/document-requests, PATCH .../:id/decision.
 * Cadena real: requireAuth (401) -> SolicitudService (ownership, transicion atomica) -> Mongo. NO cubre
 * notificaciones (correo/SMS) ni ningun mecanismo de entrega documental: eso queda fuera de este paso.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Solicitud = require("../src/domain/Solicitud");
const Folder = require("../src/domain/Folder");
const AuditEntry = require("../src/domain/AuditEntry");
const SecretsManager = require("../src/security/SecretsManager");
const SolicitudRepository = require("../src/infrastructure/SolicitudRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const { SolicitudService } = require("../src/application/SolicitudService");
const { makeCitizenRegisteredHandler } = require("../src/interfaces/eventHandlers");
const { makeFakePublisher } = require("./helpers");

const CITIZEN_SECRET = "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAu"; // 32 caracteres, solo de prueba
const ENTITY_SECRET = "Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A";
const secrets = new SecretsManager({ active: CITIZEN_SECRET });
const entitySecrets = new SecretsManager({ active: ENTITY_SECRET });

const ANA = "665f1c04c9de9c4c34f6b52a";
const DIR_ANA = "1000000001-3f9c2ab7@carpetacolombia.co";
const BEA = "665f1c04c9de9c4c34f6b52b";
const DIR_BEA = "1000000002-abcd1234@carpetacolombia.co";
const EAFIT = "6aae9153b7655900026073f1";
const ICESI = "6aae9153b7655900026073f2";
const PATH = "/api/v1/document-requests";
const CITIZEN_PATH = "/api/v1/citizens/me/document-requests";

let mongoServer;
let app;
let folderRepository;

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
  await Promise.all([Solicitud.createIndexes(), Folder.createIndexes(), AuditEntry.createIndexes()]); // dropDatabase() borra los indices
  folderRepository = new FolderRepository();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  // eventPublisher fake (PASO 3.2): estos tests son de PASO 1/2 (institucional/ciudadano), no de eventos -- la
  // cobertura de `solicitud.creada` vive en solicitudEvents.integration.test.js.
  const solicitudService = new SolicitudService({ solicitudRepository: new SolicitudRepository(), folderRepository, eventPublisher: makeFakePublisher() });
  app = buildApp({ solicitudService, secrets, entitySecrets, issuer: "ms-identidad", entityIssuer: "ms-comparticion", auditLogger });

  await makeCitizenRegisteredHandler({ folderRepository })({ ciudadanoId: ANA, direccionUnica: DIR_ANA });
  await makeCitizenRegisteredHandler({ folderRepository })({ ciudadanoId: BEA, direccionUnica: DIR_BEA });
});

/** Token institucional tal como lo emite ms-comparticion (ADR-07). */
const entityToken = (institutionId = EAFIT, { ver = true, ...claims } = {}, options = {}) =>
  entitySecrets.sign({ typ: "access", act: "entidad", ver, ...claims }, { issuer: "ms-comparticion", subject: institutionId, expiresIn: 900, ...options });
/** Token de ciudadano tal como lo emite ms-identidad (HU-02). */
const citizenToken = (ciudadanoId = ANA, options = {}) => secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: ciudadanoId, expiresIn: 900, ...options });

const REQUEST_BODY = { direccionUnica: DIR_ANA, descripcion: "Solicitar copia del certificado de estudios" };
const crear = (token = entityToken(), body = REQUEST_BODY) => request(app).post(PATH).set("Authorization", `Bearer ${token}`).send(body);

describe("Crear una solicitud (POST /document-requests)", () => {
  test("201 con la solicitud creada, estado inicial 'pendiente_autorizacion', sin ciudadanoId ni institutionId", async () => {
    const res = await crear().expect(201);

    expect(res.body).toEqual({
      id: expect.any(String),
      direccionUnica: DIR_ANA,
      descripcion: REQUEST_BODY.descripcion,
      estado: "pendiente_autorizacion",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(await Solicitud.countDocuments({ institutionId: EAFIT })).toBe(1);
  });

  test("la institucion sale SIEMPRE del token: un institutionId en el body se ignora", async () => {
    const res = await crear(entityToken(EAFIT), { ...REQUEST_BODY, institutionId: ICESI }).expect(201);

    const stored = await Solicitud.findById(res.body.id).lean();
    expect(stored.institutionId).toBe(EAFIT); // nunca ICESI, aunque el body lo pidiera
  });

  test("un ciudadanoId en el body se ignora: el ciudadano se resuelve SIEMPRE via direccionUnica", async () => {
    const OTRO_CIUDADANO = "665f1c04c9de9c4c34f6b52f";
    const res = await crear(entityToken(), { ...REQUEST_BODY, ciudadanoId: OTRO_CIUDADANO }).expect(201);

    const stored = await Solicitud.findById(res.body.id).lean();
    expect(stored.ciudadanoId).toBe(ANA); // el resuelto de verdad, nunca el que mando el cliente
  });

  test("un estado en el body se ignora: siempre nace 'pendiente_autorizacion'", async () => {
    const res = await crear(entityToken(), { ...REQUEST_BODY, estado: "autorizada" }).expect(201);

    expect(res.body.estado).toBe("pendiente_autorizacion");
    expect((await Solicitud.findById(res.body.id).lean()).estado).toBe("pendiente_autorizacion");
  });

  test("401 sin token, con token invalido, expirado, de otro emisor, o de un CIUDADANO", async () => {
    const malos = [null, "garbage.not-a.token", entityToken(EAFIT, {}, { expiresIn: -10 }), entityToken(EAFIT, {}, { issuer: "ms-identidad" }), citizenToken()];
    for (const token of malos) {
      const res = await crear(token);
      expect(res.status).toBe(401);
    }
    expect(await Solicitud.countDocuments()).toBe(0);
  });

  test("403 si la entidad NO esta verificada (no 401: la credencial es valida, falta autorizacion)", async () => {
    const res = await crear(entityToken(EAFIT, { ver: false }));

    expect(res.status).toBe(403);
    expect(await Solicitud.countDocuments()).toBe(0);
  });

  test("404 si direccionUnica esta bien formada pero no corresponde a ningun ciudadano de este operador", async () => {
    const res = await crear(entityToken(), { ...REQUEST_BODY, direccionUnica: "9999999999-zzzzzzzz@carpetacolombia.co" });

    expect(res.status).toBe(404);
    expect(await Solicitud.countDocuments()).toBe(0);
  });

  test.each([
    ["sin direccionUnica", { direccionUnica: undefined }],
    ["direccionUnica vacia", { direccionUnica: "   " }],
    ["direccionUnica con formato invalido", { direccionUnica: "no-es-un-correo" }],
    ["sin descripcion", { descripcion: undefined }],
    ["descripcion vacia", { descripcion: "   " }],
    ["descripcion mayor a 2000 caracteres", { descripcion: "a".repeat(2001) }],
  ])("400 %s, y no se crea nada", async (_name, overrides) => {
    const res = await crear(entityToken(), { ...REQUEST_BODY, ...overrides });
    expect(res.status).toBe(400);
    expect(await Solicitud.countDocuments()).toBe(0);
  });
});

describe("Listar y consultar (GET /document-requests, GET /document-requests/:id)", () => {
  test("lista solo las solicitudes de la institucion autenticada, nunca las de otra", async () => {
    await crear(entityToken(EAFIT), { ...REQUEST_BODY, descripcion: "Solicitud de EAFIT" }).expect(201);
    await crear(entityToken(ICESI), { ...REQUEST_BODY, descripcion: "Solicitud de ICESI" }).expect(201);

    const res = await request(app).get(PATH).set("Authorization", `Bearer ${entityToken(EAFIT)}`).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.solicitudes).toHaveLength(1);
    expect(res.body.solicitudes[0].descripcion).toBe("Solicitud de EAFIT");
    expect(res.body.solicitudes[0].ciudadanoId).toBeUndefined();
  });

  test("un institutionId falso en el query NUNCA se usa: se sigue filtrando por el del token", async () => {
    await crear(entityToken(EAFIT)).expect(201);

    const res = await request(app).get(`${PATH}?institutionId=${ICESI}`).set("Authorization", `Bearer ${entityToken(EAFIT)}`).expect(200);

    expect(res.body.total).toBe(1); // sigue siendo el conteo de EAFIT
  });

  test("401 al listar sin token; 403 si no esta verificada", async () => {
    await request(app).get(PATH).expect(401);
    await request(app).get(PATH).set("Authorization", `Bearer ${entityToken(EAFIT, { ver: false })}`).expect(403);
  });

  test("lista vacia correctamente (institucion sin solicitudes)", async () => {
    const res = await request(app).get(PATH).set("Authorization", `Bearer ${entityToken(EAFIT)}`).expect(200);

    expect(res.body).toEqual({ solicitudes: [], total: 0, currentPage: 1, pageSize: 10, totalPages: 0 });
  });

  test("paginacion: page y pageSize se respetan", async () => {
    for (let i = 0; i < 3; i++) await crear(entityToken(EAFIT), { ...REQUEST_BODY, descripcion: `Solicitud ${i}` }).expect(201);

    const res = await request(app).get(`${PATH}?page=2&pageSize=2`).set("Authorization", `Bearer ${entityToken(EAFIT)}`).expect(200);

    expect(res.body).toMatchObject({ total: 3, currentPage: 2, pageSize: 2, totalPages: 2 });
    expect(res.body.solicitudes).toHaveLength(1);
  });

  test("una institucion puede consultar su propia solicitud por id, sin ciudadanoId en la respuesta", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);

    const res = await request(app).get(`${PATH}/${creada.body.id}`).set("Authorization", `Bearer ${entityToken(EAFIT)}`).expect(200);

    expect(res.body).toMatchObject({ id: creada.body.id, direccionUnica: DIR_ANA });
    expect(res.body.ciudadanoId).toBeUndefined();
    expect(res.body.institutionId).toBeUndefined();
  });

  test("404 si otra institucion intenta consultar una solicitud ajena (nunca 403)", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);

    const res = await request(app).get(`${PATH}/${creada.body.id}`).set("Authorization", `Bearer ${entityToken(ICESI)}`);

    expect(res.status).toBe(404);
  });

  test("404 si la solicitud no existe; 400 si el id no tiene formato de ObjectId", async () => {
    await request(app).get(`${PATH}/665f1c04c9de9c4c34f6b52a`).set("Authorization", `Bearer ${entityToken()}`).expect(404);
    await request(app).get(`${PATH}/no-es-un-id`).set("Authorization", `Bearer ${entityToken()}`).expect(400);
  });
});

describe("Integridad de los datos almacenados", () => {
  test("el ciudadanoId guardado es el resuelto REALMENTE desde Folder, no uno inventado", async () => {
    const res = await crear().expect(201);
    const stored = await Solicitud.findById(res.body.id).lean();

    const folder = await folderRepository.findByDireccionUnica(DIR_ANA);
    expect(stored.ciudadanoId).toBe(folder.ciudadanoId);
    expect(stored.ciudadanoId).toBe(ANA);
  });

  test("el estado inicial almacenado es exactamente 'pendiente_autorizacion'", async () => {
    const res = await crear().expect(201);
    expect((await Solicitud.findById(res.body.id).lean()).estado).toBe("pendiente_autorizacion");
  });

  test("el institutionId almacenado corresponde exactamente al sub del JWT usado", async () => {
    const res = await crear(entityToken(ICESI)).expect(201);
    expect((await Solicitud.findById(res.body.id).lean()).institutionId).toBe(ICESI);
  });

  test("decisionAt y decisionBy nacen en null", async () => {
    const res = await crear().expect(201);
    const stored = await Solicitud.findById(res.body.id).lean();
    expect(stored.decisionAt).toBeNull();
    expect(stored.decisionBy).toBeNull();
  });
});

describe("Consultar mis solicitudes (GET /citizens/me/document-requests) -- PASO 2", () => {
  test("401 sin token, con token invalido, o con un token INSTITUCIONAL usado como ciudadano", async () => {
    for (const token of [null, "garbage.not-a.token", entityToken(EAFIT)]) {
      const req = request(app).get(CITIZEN_PATH);
      const res = await (token ? req.set("Authorization", `Bearer ${token}`) : req);
      expect(res.status).toBe(401);
    }
  });

  test("el ciudadano autenticado obtiene solamente sus propias solicitudes; las de otro ciudadano no aparecen", async () => {
    await crear(entityToken(EAFIT), { ...REQUEST_BODY, direccionUnica: DIR_ANA }).expect(201);
    await crear(entityToken(EAFIT), { ...REQUEST_BODY, direccionUnica: DIR_BEA }).expect(201);

    const res = await request(app).get(CITIZEN_PATH).set("Authorization", `Bearer ${citizenToken(ANA)}`).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.solicitudes[0].direccionUnica).toBe(DIR_ANA);
  });

  test("lista vacia correctamente", async () => {
    const res = await request(app).get(CITIZEN_PATH).set("Authorization", `Bearer ${citizenToken(ANA)}`).expect(200);
    expect(res.body).toEqual({ solicitudes: [], total: 0, currentPage: 1, pageSize: 10, totalPages: 0 });
  });

  test("paginacion: page y pageSize se respetan", async () => {
    for (let i = 0; i < 3; i++) await crear(entityToken(EAFIT), { ...REQUEST_BODY, descripcion: `Solicitud ${i}` }).expect(201);

    const res = await request(app).get(`${CITIZEN_PATH}?page=2&pageSize=2`).set("Authorization", `Bearer ${citizenToken(ANA)}`).expect(200);

    expect(res.body).toMatchObject({ total: 3, currentPage: 2, pageSize: 2, totalPages: 2 });
    expect(res.body.solicitudes).toHaveLength(1);
  });

  test("un ciudadanoId en el query NUNCA cambia el filtro: sigue viendo solo lo suyo", async () => {
    await crear(entityToken(EAFIT), { ...REQUEST_BODY, direccionUnica: DIR_BEA }).expect(201); // de BEA, no de ANA

    const res = await request(app).get(`${CITIZEN_PATH}?ciudadanoId=${BEA}`).set("Authorization", `Bearer ${citizenToken(ANA)}`).expect(200);

    expect(res.body.total).toBe(0); // sigue siendo el conteo de ANA (el del token), no el de BEA
  });

  test("un institutionId en el query no altera el resultado (no es un filtro que este endpoint use)", async () => {
    await crear(entityToken(EAFIT)).expect(201);

    const res = await request(app).get(`${CITIZEN_PATH}?institutionId=${ICESI}`).set("Authorization", `Bearer ${citizenToken(ANA)}`).expect(200);

    expect(res.body.total).toBe(1);
  });

  test("la respuesta NO contiene ciudadanoId, pero SI institutionId (el ciudadano necesita saber quien pregunta)", async () => {
    await crear(entityToken(EAFIT)).expect(201);

    const res = await request(app).get(CITIZEN_PATH).set("Authorization", `Bearer ${citizenToken(ANA)}`).expect(200);

    expect(res.body.solicitudes[0].ciudadanoId).toBeUndefined();
    expect(res.body.solicitudes[0].institutionId).toBe(EAFIT);
    expect(JSON.stringify(res.body)).not.toContain(ANA);
  });
});

describe("Decidir una solicitud (PATCH /citizens/me/document-requests/:id/decision) -- PASO 2", () => {
  const decidir = (id, decision, token = citizenToken(ANA)) =>
    request(app).patch(`${CITIZEN_PATH}/${id}/decision`).set("Authorization", `Bearer ${token}`).send(decision === undefined ? {} : { decision });

  test("401 sin token, con token invalido", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);
    await request(app).patch(`${CITIZEN_PATH}/${creada.body.id}/decision`).send({ decision: "autorizar" }).expect(401);
    await request(app).patch(`${CITIZEN_PATH}/${creada.body.id}/decision`).set("Authorization", "Bearer garbage.not-a.token").send({ decision: "autorizar" }).expect(401);
  });

  test("400 si el id no tiene formato de ObjectId", async () => {
    await decidir("no-es-un-id", "autorizar").expect(400);
  });

  test("404 si la solicitud no existe", async () => {
    await decidir("665f1c04c9de9c4c34f6b52a", "autorizar").expect(404);
  });

  test("404 si la solicitud pertenece a OTRO ciudadano (nunca 403; no revela que exista)", async () => {
    const creada = await crear(entityToken(EAFIT), { ...REQUEST_BODY, direccionUnica: DIR_BEA }).expect(201); // solicitud de BEA

    const res = await decidir(creada.body.id, "autorizar", citizenToken(ANA)); // ANA intenta decidir la de BEA

    expect(res.status).toBe(404);
    expect((await Solicitud.findById(creada.body.id).lean()).estado).toBe("pendiente_autorizacion"); // intacta
  });

  test.each([
    ["sin decision", undefined],
    ["'tal_vez'", "tal_vez"],
    ["'si'", "si"],
    ["'no'", "no"],
    ["'authorized' (ingles)", "authorized"],
    ["boolean true", true],
    ["null", null],
  ])("400 con decision = %s, y no se modifica la solicitud", async (_name, decisionValue) => {
    const creada = await crear(entityToken(EAFIT)).expect(201);

    const res = await decidir(creada.body.id, decisionValue);

    expect(res.status).toBe(400);
    expect((await Solicitud.findById(creada.body.id).lean()).estado).toBe("pendiente_autorizacion");
  });

  test("autorizar una solicitud propia pendiente -> 200, con institutionId pero sin ciudadanoId en la respuesta", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);

    const res = await decidir(creada.body.id, "autorizar").expect(200);

    expect(res.body).toMatchObject({ id: creada.body.id, institutionId: EAFIT, direccionUnica: DIR_ANA, estado: "autorizada" });
    expect(res.body.ciudadanoId).toBeUndefined();
    expect(res.body.decisionAt).toEqual(expect.any(String));
    expect(res.body.decisionBy).toBe(ANA);
  });

  test("rechazar una solicitud propia pendiente -> 200", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);

    const res = await decidir(creada.body.id, "rechazar").expect(200);

    expect(res.body.estado).toBe("rechazada");
    expect(res.body.decisionBy).toBe(ANA);
  });

  test("decisionAt queda establecido con la fecha actual y decisionBy corresponde al ciudadano del JWT", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);
    const antes = Date.now();

    await decidir(creada.body.id, "autorizar").expect(200);

    const stored = await Solicitud.findById(creada.body.id).lean();
    expect(new Date(stored.decisionAt).getTime()).toBeGreaterThanOrEqual(antes - 1000);
    expect(stored.decisionBy).toBe(ANA);
  });

  test("la institucion propietaria y el ciudadanoId almacenados permanecen intactos tras la decision", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);

    await decidir(creada.body.id, "autorizar").expect(200);

    const stored = await Solicitud.findById(creada.body.id).lean();
    expect(stored.institutionId).toBe(EAFIT);
    expect(stored.ciudadanoId).toBe(ANA);
  });

  test("409 al autorizar una solicitud ya autorizada", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);
    await decidir(creada.body.id, "autorizar").expect(200);

    await decidir(creada.body.id, "autorizar").expect(409);
  });

  test("409 al rechazar una solicitud ya rechazada", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);
    await decidir(creada.body.id, "rechazar").expect(200);

    await decidir(creada.body.id, "rechazar").expect(409);
  });

  test("409 al rechazar una solicitud ya autorizada (sin revocacion de consentimiento)", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);
    await decidir(creada.body.id, "autorizar").expect(200);

    await decidir(creada.body.id, "rechazar").expect(409);
    expect((await Solicitud.findById(creada.body.id).lean()).estado).toBe("autorizada"); // no se sobreescribio
  });

  test("409 al autorizar una solicitud ya rechazada (sin revocacion de consentimiento)", async () => {
    const creada = await crear(entityToken(EAFIT)).expect(201);
    await decidir(creada.body.id, "rechazar").expect(200);

    await decidir(creada.body.id, "autorizar").expect(409);
    expect((await Solicitud.findById(creada.body.id).lean()).estado).toBe("rechazada");
  });
});
