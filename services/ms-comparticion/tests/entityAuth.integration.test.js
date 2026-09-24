const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Institution = require("../src/domain/Institution");
const AuditEntry = require("../src/domain/AuditEntry");
const { InstitutionRepository } = require("../src/infrastructure/InstitutionRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const SecretsManager = require("../src/security/SecretsManager");
const requireEntityAuth = require("../src/security/requireEntityAuth");
const logger = require("../src/tracing/logger");
const { InstitutionService } = require("../src/application/InstitutionService");
const { EntityAuthService } = require("../src/application/EntityAuthService");

const ENTITY_SECRET = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const OTHER_ENTITY_SECRET = "Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A";
// La llave con la que ms-identidad firma los tokens de CIUDADANO. Este servicio no la usa para nada: se define
// aqui solo para fabricar un token de ciudadano y comprobar que NO abre ninguna puerta institucional.
const CITIZEN_SECRET = "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAu";
const PASSWORD = "Clave-institucional-123";
const valid = { nombre: "Universidad EAFIT", tipo: "universidad", nit: "890.901.389-5", correoContacto: "registro@eafit.edu.co" };

const entitySecrets = new SecretsManager({ active: ENTITY_SECRET });
const citizenSecrets = new SecretsManager({ active: CITIZEN_SECRET });

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
  logger.resetSink();
  await mongoose.connection.dropDatabase();
});
beforeEach(async () => {
  await Promise.all([Institution.createIndexes(), AuditEntry.createIndexes()]);
  const institutionRepository = new InstitutionRepository();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  app = buildApp({
    institutionService: new InstitutionService({ institutionRepository, auditLogger }),
    entityAuthService: new EntityAuthService({ institutionRepository, secrets: entitySecrets, auditLogger }),
  });
});

const registrar = (body = {}) => request(app).post("/api/v1/institutions").send({ ...valid, password: PASSWORD, ...body });
const pedirToken = (body) => request(app).post("/api/v1/institutions/auth/token").send(body);

/** Token de ciudadano tal como lo emite ms-identidad (HU-02): otra llave, otro emisor, sin `act`. */
const citizenToken = (claims = {}, options = {}) =>
  citizenSecrets.sign({ typ: "access", ...claims }, { issuer: "ms-identidad", subject: "665f1c04c9de9c4c34f6b52a", expiresIn: 900, ...options });

describe("POST /api/v1/institutions/auth/token (integracion)", () => {
  test("200 con el token institucional y sin cacheo; el registro acepta la contrasena", async () => {
    await registrar().expect(201);

    const res = await pedirToken({ nit: valid.nit, password: PASSWORD }).expect(200);

    expect(Object.keys(res.body).sort()).toEqual(["accessToken", "expiresIn", "tokenType"]);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.expiresIn).toBe(900);
  });

  test("el registro sigue respondiendo exactamente {institutionId}: la contrasena no cambia su contrato (HU-06.1)", async () => {
    const res = await registrar().expect(201);
    expect(Object.keys(res.body)).toEqual(["institutionId"]);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
  });

  test.each([
    ["contrasena incorrecta", { nit: valid.nit, password: "otra-clave-distinta" }],
    ["institucion inexistente", { nit: "899999068", password: PASSWORD }],
    ["NIT mal formado", { nit: "basura", password: PASSWORD }],
    ["sin contrasena", { nit: valid.nit }],
    ["cuerpo vacio", {}],
  ])("401 generico: %s", async (_name, body) => {
    await registrar().expect(201);

    const res = await pedirToken(body);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "credenciales invalidas" });
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
  });

  test("una entidad registrada SIN contrasena recibe el mismo 401 (no se distingue de una mala clave)", async () => {
    await request(app).post("/api/v1/institutions").send(valid).expect(201);

    const res = await pedirToken({ nit: valid.nit, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "credenciales invalidas" });
  });

  test("415 si el cuerpo no es JSON y 400 si el JSON esta mal formado", async () => {
    await request(app).post("/api/v1/institutions/auth/token").set("Content-Type", "text/plain").send("nit=1").expect(415);
    const res = await request(app).post("/api/v1/institutions/auth/token").set("Content-Type", "application/json").send("{roto");
    expect(res.status).toBe(400);
  });

  test("413 si el cuerpo es enorme: no se procesa", async () => {
    const res = await pedirToken({ nit: valid.nit, password: "x".repeat(10000) });
    expect(res.status).toBe(413);
  });

  test("un cuerpo que no es un objeto nunca da 500: un arreglo son credenciales ausentes (401) y un valor suelto no es JSON valido en modo estricto (400)", async () => {
    const enviar = (body) => request(app).post("/api/v1/institutions/auth/token").set("Content-Type", "application/json").send(JSON.stringify(body));

    await enviar([]).expect(401);
    for (const body of ["texto", 42, null]) await enviar(body).expect(400);
  });

  test("el registro de entidades (HU-06.1) sigue funcionando igual junto a la nueva ruta", async () => {
    await registrar().expect(201);
    const duplicado = await registrar({ nombre: "Otra" });
    expect(duplicado.status).toBe(409);
    const invalido = await request(app).post("/api/v1/institutions").send({ nombre: "x" });
    expect(invalido.status).toBe(400);
  });

  test("sin entityAuthService la ruta no existe: 404 (el resto del servicio sigue igual)", async () => {
    const soloRegistro = buildApp({ institutionService: new InstitutionService({ institutionRepository: new InstitutionRepository() }) });

    await request(soloRegistro).post("/api/v1/institutions/auth/token").send({ nit: valid.nit, password: PASSWORD }).expect(404);
    await request(soloRegistro).post("/api/v1/institutions").send(valid).expect(201);
  });

  test("devuelve el x-trace-id y la bitacora lo enlaza (HT-06)", async () => {
    await registrar().expect(201);

    const res = await request(app).post("/api/v1/institutions/auth/token").set("x-trace-id", "traza-login-0001").send({ nit: valid.nit, password: PASSWORD }).expect(200);

    expect(res.headers["x-trace-id"]).toBe("traza-login-0001");
    expect((await AuditEntry.findOne({ action: "institucion.autenticar" }).lean()).traceId).toBe("traza-login-0001");
  });

  test("la contrasena no aparece en ningun log, ni en el registro ni en el login", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));

    await registrar();
    await pedirToken({ nit: valid.nit, password: PASSWORD });
    await pedirToken({ nit: valid.nit, password: "mala" });

    expect(lines.join("\n")).not.toContain(PASSWORD);
  });
});

describe("requireEntityAuth: solo pasa un token INSTITUCIONAL vigente", () => {
  /** App minima con una ruta protegida por el middleware institucional. */
  const protegida = (secrets = entitySecrets) => {
    const a = express();
    a.get("/interna", requireEntityAuth(secrets), (req, res) => res.status(200).json(req.auth));
    return a;
  };

  const entityToken = async () => {
    await registrar().expect(201);
    return (await pedirToken({ nit: valid.nit, password: PASSWORD }).expect(200)).body.accessToken;
  };

  test("token institucional valido -> pasa y deja req.auth.institutionId, NUNCA ciudadanoId", async () => {
    const token = await entityToken();
    const institucion = await Institution.findOne({ nit: "890901389" }).lean();

    const res = await request(protegida()).get("/interna").set("Authorization", `Bearer ${token}`).expect(200);

    expect(res.body.institutionId).toBe(String(institucion._id));
    expect(res.body.actorType).toBe("entidad");
    expect(res.body.verificada).toBe(false);
    expect(res.body).not.toHaveProperty("ciudadanoId");
  });

  test("401 con un token institucional EXPIRADO", async () => {
    const expirado = entitySecrets.sign({ typ: "access", act: "entidad" }, { issuer: "ms-comparticion", subject: "abc", expiresIn: -10 });

    await request(protegida()).get("/interna").set("Authorization", `Bearer ${expirado}`).expect(401);
  });

  test("401 con un token de CIUDADANO: ni su llave ni su emisor ni su actor sirven aqui", async () => {
    for (const token of [citizenToken(), citizenToken({ act: "entidad" }), citizenToken({ typ: "refresh" })]) {
      const res = await request(protegida()).get("/interna").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "token invalido o expirado" });
    }
  });

  test("401 con un token firmado con la llave de ciudadanos aunque imite TODOS los claims institucionales", async () => {
    const imitador = citizenSecrets.sign({ typ: "access", act: "entidad" }, { issuer: "ms-comparticion", subject: "abc", expiresIn: 900 });

    await request(protegida()).get("/interna").set("Authorization", `Bearer ${imitador}`).expect(401);
  });

  test.each([
    ["sin claim act", { typ: "access" }],
    ["act de otro tipo", { typ: "access", act: "ciudadano" }],
    ["no es access", { typ: "refresh", act: "entidad" }],
  ])("401 con un token de esta misma llave pero %s", async (_name, claims) => {
    const token = entitySecrets.sign(claims, { issuer: "ms-comparticion", subject: "abc", expiresIn: 900 });
    await request(protegida()).get("/interna").set("Authorization", `Bearer ${token}`).expect(401);
  });

  test("401 con otro emisor, sin subject, con otra llave de entidad, alg=none o encabezado mal formado", async () => {
    const valido = await entityToken();
    const [h, , s] = valido.split(".");
    const payloadFalso = Buffer.from(JSON.stringify({ typ: "access", act: "entidad", iss: "ms-comparticion", sub: "otra", exp: 9999999999 })).toString("base64url");
    const cabeceraNone = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");

    const malos = [
      entitySecrets.sign({ typ: "access", act: "entidad" }, { issuer: "otro-servicio", subject: "abc", expiresIn: 900 }),
      entitySecrets.sign({ typ: "access", act: "entidad" }, { issuer: "ms-comparticion", expiresIn: 900 }), // sin sub
      new SecretsManager({ active: OTHER_ENTITY_SECRET }).sign({ typ: "access", act: "entidad" }, { issuer: "ms-comparticion", subject: "abc", expiresIn: 900 }),
      `${cabeceraNone}.${payloadFalso}.`,
      `${h}.${payloadFalso}.${s}`,
    ];
    for (const token of malos) await request(protegida()).get("/interna").set("Authorization", `Bearer ${token}`).expect(401);

    for (const header of [undefined, "", "Bearer", "Basic abc", "Bearer no.es.jwt", "suelto"]) {
      const r = request(protegida()).get("/interna");
      const res = await (header === undefined ? r : r.set("Authorization", header));
      expect(res.status).toBe(401);
    }
  });

  test("sin llavero institucional configurado el middleware falla CERRADO (401), no abre la puerta", async () => {
    const token = await entityToken();

    await request(protegida(null)).get("/interna").set("Authorization", `Bearer ${token}`).expect(401);
  });

  test("durante una rotacion de llave, un token firmado con la anterior sigue valiendo", async () => {
    const token = await entityToken();
    const rotado = new SecretsManager({ active: OTHER_ENTITY_SECRET, previous: [ENTITY_SECRET] });

    await request(protegida(rotado)).get("/interna").set("Authorization", `Bearer ${token}`).expect(200);
  });
});
