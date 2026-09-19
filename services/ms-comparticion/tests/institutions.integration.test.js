const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Institution = require("../src/domain/Institution");
const AuditEntry = require("../src/domain/AuditEntry");
const { InstitutionRepository } = require("../src/infrastructure/InstitutionRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const logger = require("../src/tracing/logger");
const { InstitutionService } = require("../src/application/InstitutionService");

const valid = { nombre: "Universidad EAFIT", tipo: "universidad", nit: "890.901.389-5", correoContacto: "registro@eafit.edu.co" };
const TOKEN = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
afterEach(async () => {
  logger.resetSink();
  await mongoose.connection.dropDatabase();
});
beforeEach(async () => {
  await Promise.all([Institution.createIndexes(), AuditEntry.createIndexes()]);
});

const appWith = (registrationToken = "") =>
  buildApp({
    institutionService: new InstitutionService({ institutionRepository: new InstitutionRepository(), auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }) }),
    registrationToken,
  });
const post = (app, body, headers = {}) => request(app).post("/api/v1/institutions").set(headers).send(body);

describe("POST /api/v1/institutions (integracion)", () => {
  test("201 con {institutionId} exactamente: la entidad y su carpeta institucional quedan creadas", async () => {
    const res = await post(appWith(), valid).expect(201);

    expect(Object.keys(res.body)).toEqual(["institutionId"]);
    const doc = await Institution.findById(res.body.institutionId).lean();
    expect(doc.carpeta).toMatchObject({ estado: "activa" });
    expect(doc.nombre).toBe("Universidad EAFIT");
  });

  test("no expone en la respuesta datos internos (carpeta, NIT, correo)", async () => {
    const res = await post(appWith(), valid).expect(201);
    expect(JSON.stringify(res.body)).not.toMatch(/carpeta|890901389|eafit\.edu\.co/);
  });

  test("400 con TODOS los problemas listados cuando faltan o sobran datos", async () => {
    const res = await post(appWith(), { nombre: "x", tipo: "otro-tipo", nit: "123", correoContacto: "no" }).expect(400);

    expect(res.body.error).toBe("datos invalidos");
    expect(res.body.detalles.length).toBeGreaterThanOrEqual(4);
    expect(await Institution.countDocuments()).toBe(0);
  });

  test("409 si el NIT ya esta registrado, aunque se escriba distinto; no se crea otra entidad", async () => {
    const app = appWith();
    await post(app, valid).expect(201);

    const res = await post(app, { ...valid, nit: "890901389", nombre: "Otra Entidad" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ya existe/);
    expect(await Institution.countDocuments()).toBe(1);
  });

  test("8 registros simultaneos del mismo NIT por HTTP -> 1 x 201 y 7 x 409", async () => {
    const app = appWith();
    const results = await Promise.all(Array.from({ length: 8 }, () => post(app, valid)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
  });

  test("415 si el cuerpo no es JSON", async () => {
    const res = await request(appWith()).post("/api/v1/institutions").set("Content-Type", "text/plain").send("nombre=x");
    expect(res.status).toBe(415);
  });

  test("400 si el JSON esta mal formado", async () => {
    const res = await request(appWith()).post("/api/v1/institutions").set("Content-Type", "application/json").send("{esto no es json");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JSON/);
  });

  test("413 si el cuerpo es enorme (limite 16 KB): no se procesa", async () => {
    const res = await post(appWith(), { ...valid, direccion: "x".repeat(20000) });
    expect(res.status).toBe(413);
    expect(await Institution.countDocuments()).toBe(0);
  });

  test("un cuerpo que es un arreglo o un valor suelto da 400, no un 500", async () => {
    for (const body of [[], "texto", 42, null]) {
      const res = await request(appWith()).post("/api/v1/institutions").set("Content-Type", "application/json").send(JSON.stringify(body));
      expect(res.status).toBe(400);
    }
  });

  test("intentar fijar campos internos (verificada, carpeta) se ignora", async () => {
    const res = await post(appWith(), { ...valid, verificada: true, carpeta: { id: "mia" } }).expect(201);
    const doc = await Institution.findById(res.body.institutionId).lean();
    expect(doc.verificada).toBe(false);
    expect(doc.carpeta.id).not.toBe("mia");
  });

  test("un error interno inesperado da 500 generico, sin detalles", async () => {
    jest.spyOn(Institution, "create").mockRejectedValueOnce(new Error("secreto interno: cadena de conexion"));
    const res = await post(appWith(), valid);
    jest.restoreAllMocks();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Error interno" });
  });

  test("devuelve el x-trace-id, y la bitacora lo enlaza (HT-06); no anuncia el framework", async () => {
    const res = await post(appWith(), valid, { "x-trace-id": "traza-cliente-0001" }).expect(201);

    expect(res.headers["x-trace-id"]).toBe("traza-cliente-0001");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect((await AuditEntry.findOne({ action: "institucion.registrar" }).lean()).traceId).toBe("traza-cliente-0001");
  });

  test("los logs no contienen el correo, el nombre ni el NIT de la entidad", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));
    const app = appWith();
    await post(app, valid).expect(201);
    await post(app, valid).expect(409);
    jest.spyOn(Institution, "create").mockRejectedValueOnce(new Error("boom"));
    await post(app, { ...valid, nit: "899999068" });
    jest.restoreAllMocks();

    const dump = lines.join("\n");
    expect(dump).toContain("request.start"); // hubo logs que revisar
    for (const pii of ["registro@eafit.edu.co", "Universidad EAFIT", "890901389", "890.901.389"]) expect(dump).not.toContain(pii);
  });
});

describe("REGISTRATION_TOKEN (opcional): registro solo para quien lo tenga", () => {
  test("con token configurado, sin el encabezado -> 401 y no se crea nada ni se lee el cuerpo", async () => {
    const res = await post(appWith(TOKEN), valid);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/token/);
    expect(await Institution.countDocuments()).toBe(0);
  });

  test.each([["incorrecto", "otro-token"], ["vacio", ""], ["parecido", `${TOKEN}x`], ["en minusculas", TOKEN.toLowerCase()]])("token %s -> 401", async (_name, token) => {
    const res = await post(appWith(TOKEN), valid, { "x-registration-token": token });
    expect(res.status).toBe(401);
  });

  test("HTTP recorta los espacios al inicio y al final del valor de un encabezado: ' TOKEN ' llega como TOKEN (semantica de HTTP, no un fallo)", async () => {
    await post(appWith(TOKEN), valid, { "x-registration-token": ` ${TOKEN} ` }).expect(201);
  });

  test("con el token correcto -> 201", async () => {
    await post(appWith(TOKEN), valid, { "x-registration-token": TOKEN }).expect(201);
  });

  test("el token se comprueba ANTES del formato: un cuerpo invalido sin token recibe 401, no 400 (no revela nada al no autorizado)", async () => {
    const res = await request(appWith(TOKEN)).post("/api/v1/institutions").set("Content-Type", "text/plain").send("basura");
    expect(res.status).toBe(401);
  });

  test("sin token configurado el registro es abierto (el flujo del issue), y un token enviado de mas no molesta", async () => {
    await post(appWith(""), valid, { "x-registration-token": "cualquiera" }).expect(201);
  });

  test("el token no aparece en ningun log", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));
    await post(appWith(TOKEN), valid, { "x-registration-token": "intento-fallido-secreto" });
    expect(lines.join("\n")).not.toContain("intento-fallido-secreto");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
