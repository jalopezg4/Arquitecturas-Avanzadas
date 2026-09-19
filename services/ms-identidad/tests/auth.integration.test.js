const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Citizen = require("../src/domain/Citizen");
const AuditEntry = require("../src/domain/AuditEntry");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const RefreshSessionRepository = require("../src/infrastructure/RefreshSessionRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const SecretsManager = require("../src/security/SecretsManager");
const requireAuth = require("../src/security/requireAuth");
const logger = require("../src/tracing/logger");
const { AuthService } = require("../src/application/AuthService");
const { CitizenSagaService } = require("../src/application/CitizenSagaService");

const SECRET = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const OTHER_SECRET = "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAu";
const body = { documento: 1555666777, nombre: "Ana Gomez", direccion: "Cra 1 # 2-3", correo: "ana@example.com", password: "Sup3rSecreta!" };

let mongoServer;
let secrets;
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

beforeEach(() => {
  secrets = new SecretsManager({ active: SECRET });
  const citizenRepository = new CitizenRepository();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const govCarpetaClient = {
    validateCitizen: async () => ({ available: true }),
    registerCitizen: async () => {},
    unregisterCitizen: async () => {},
  };
  app = buildApp({
    citizenSagaService: new CitizenSagaService({ citizenRepository, govCarpetaClient, eventPublisher: { publish: async () => {} }, auditLogger }),
    authService: new AuthService({ citizenRepository, refreshSessionRepository: new RefreshSessionRepository(), secrets, auditLogger }),
    secrets,
  });
});

const register = () => request(app).post("/api/v1/citizens").send(body);
const login = (payload) => request(app).post("/api/v1/auth/login").send(payload);
const good = { documento: body.documento, password: body.password };

describe("POST /api/v1/auth/login (integracion, flujo real registro -> login)", () => {
  test("200 con {accessToken, refreshToken, expiresIn: 900} para un ciudadano recien registrado", async () => {
    await register().expect(201);

    const res = await login(good).expect(200);

    expect(Object.keys(res.body).sort()).toEqual(["accessToken", "expiresIn", "refreshToken"]);
    expect(res.body.expiresIn).toBe(900);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { exp, iat } = jwt.decode(res.body.accessToken);
    expect(exp - iat).toBe(900);
  });

  test("401 generico e IDENTICO para password incorrecto y para documento inexistente (mismo status y mismo cuerpo)", async () => {
    await register().expect(201);

    const wrongPass = await login({ ...good, password: "otraClave123" });
    const unknown = await login({ documento: 999888777, password: "otraClave123" });

    expect(wrongPass.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrongPass.body);
    expect(wrongPass.body).toEqual({ error: "credenciales invalidas" });
  });

  test("400 si faltan campos (no es un intento de autenticacion)", async () => {
    await login({}).expect(400);
    await login({ documento: body.documento }).expect(400);
    await login({ documento: "abc", password: "x" }).expect(400);
  });

  test("tras 5 intentos fallidos, hasta el password correcto recibe el mismo 401 generico", async () => {
    await register().expect(201);
    for (let i = 0; i < 4; i++) await login({ ...good, password: "mala" }).expect(401);
    await login(good).expect(200); // con 4 fallos aun se puede entrar, y reinicia el contador
    for (let i = 0; i < 5; i++) await login({ ...good, password: "mala" }).expect(401);

    const locked = await login(good);

    expect(locked.status).toBe(401);
    expect(locked.body).toEqual({ error: "credenciales invalidas" });
  });

  test("un ciudadano que no completo el registro (pendiente) no puede entrar", async () => {
    await register().expect(201);
    await Citizen.updateOne({ documento: body.documento }, { estado: "pendiente" });

    await login(good).expect(401);
  });

  test("queda registro en la bitacora del login exitoso y del fallido, sin el password", async () => {
    await register().expect(201);
    await login({ ...good, password: "claveEquivocada1" }).expect(401);
    await login(good).expect(200);

    const entries = await AuditEntry.find({ action: "ciudadano.login" }).sort({ timestamp: 1 }).lean();

    expect(entries.map((e) => e.outcome)).toEqual(["fallo", "exito"]);
    expect(entries.every((e) => e.traceId)).toBe(true); // enlazado al trace-id del request (HT-06)
    expect(JSON.stringify(entries)).not.toContain("claveEquivocada1");
  });

  test("los logs del request no incluyen el password", async () => {
    await register().expect(201);
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));

    await login({ ...good, password: "claveEquivocada1" }).expect(401);
    await login(good).expect(200);

    const dump = lines.join("\n");
    expect(dump).not.toContain("claveEquivocada1");
    expect(dump).not.toContain(body.password);
  });
});

describe("Middleware de token: rechaza sin token, expirado, manipulado o del tipo equivocado", () => {
  const me = (token) => {
    const r = request(app).get("/api/v1/auth/me");
    return token === undefined ? r : r.set("Authorization", token);
  };

  test("200 con un access token valido, y devuelve la identidad del token", async () => {
    await register().expect(201);
    const { body: tokens } = await login(good).expect(200);

    const res = await me(`Bearer ${tokens.accessToken}`).expect(200);

    expect(res.body.ciudadanoId).toBe(jwt.decode(tokens.accessToken).sub);
  });

  test("401 sin token, con encabezado mal formado o con basura", async () => {
    for (const header of [undefined, "", "Bearer", "Bearer ", "Basic abc", "Bearer no.es.un-jwt", "token-suelto"]) {
      const res = await me(header);
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
    }
  });

  test("401 con un token expirado", async () => {
    const expired = secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: "abc", expiresIn: -10 });
    await me(`Bearer ${expired}`).expect(401);
  });

  test("401 con un refresh token: no sirve para llamar a la API", async () => {
    await register().expect(201);
    const { body: tokens } = await login(good).expect(200);

    await me(`Bearer ${tokens.refreshToken}`).expect(401);
  });

  test("401 con firma de otra llave, alg=none o payload alterado", async () => {
    await register().expect(201);
    const { body: tokens } = await login(good).expect(200);
    const foreign = new SecretsManager({ active: OTHER_SECRET }).sign({ typ: "access" }, { issuer: "ms-identidad", subject: "abc", expiresIn: 900 });
    const [h, , s] = tokens.accessToken.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ typ: "access", iss: "ms-identidad", sub: "otro-ciudadano", exp: 9999999999 })).toString("base64url");
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");

    for (const token of [foreign, `${h}.${forgedPayload}.${s}`, `${noneHeader}.${forgedPayload}.`]) {
      await me(`Bearer ${token}`).expect(401);
    }
  });

  test("401 si el emisor no es ms-identidad", async () => {
    const other = secrets.sign({ typ: "access" }, { issuer: "otro-servicio", subject: "abc", expiresIn: 900 });
    await me(`Bearer ${other}`).expect(401);
  });
});

describe("Revalidacion independiente en cada microservicio (ADR-06)", () => {
  /** Simula ms-documentos: su propio proceso, su propio llavero, sin llamar a ms-identidad. */
  function otherService(keyRing) {
    const svc = express();
    svc.get("/documentos", requireAuth(keyRing), (req, res) => res.json({ ciudadanoId: req.auth.ciudadanoId }));
    return svc;
  }

  test("otro servicio con la misma llave valida el token por si mismo, sin consultar a ms-identidad ni al gateway", async () => {
    await register().expect(201);
    const { body: tokens } = await login(good).expect(200);

    const res = await request(otherService(new SecretsManager({ active: SECRET })))
      .get("/documentos")
      .set("Authorization", `Bearer ${tokens.accessToken}`)
      .expect(200);

    expect(res.body.ciudadanoId).toBe(jwt.decode(tokens.accessToken).sub);
  });

  test("otro servicio rechaza un token que no vino de la llave compartida, aunque el gateway lo hubiera dejado pasar", async () => {
    const forged = new SecretsManager({ active: OTHER_SECRET }).sign({ typ: "access" }, { issuer: "ms-identidad", subject: "abc", expiresIn: 900 });

    await request(otherService(new SecretsManager({ active: SECRET }))).get("/documentos").set("Authorization", `Bearer ${forged}`).expect(401);
  });

  test("otro servicio rechaza un token expirado", async () => {
    const expired = secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: "abc", expiresIn: -1 });

    await request(otherService(new SecretsManager({ active: SECRET }))).get("/documentos").set("Authorization", `Bearer ${expired}`).expect(401);
  });

  test("durante una rotacion de llave, el token emitido con la llave vieja sigue valiendo en el otro servicio", async () => {
    await register().expect(201);
    const { body: tokens } = await login(good).expect(200);
    const rotated = new SecretsManager({ active: OTHER_SECRET, previous: [SECRET] });

    await request(otherService(rotated)).get("/documentos").set("Authorization", `Bearer ${tokens.accessToken}`).expect(200);
  });
});
