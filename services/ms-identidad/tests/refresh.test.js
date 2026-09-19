const argon2 = require("argon2");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Citizen = require("../src/domain/Citizen");
const RefreshSession = require("../src/domain/RefreshSession");
const AuditEntry = require("../src/domain/AuditEntry");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const RefreshSessionRepository = require("../src/infrastructure/RefreshSessionRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const SecretsManager = require("../src/security/SecretsManager");
const requireAuth = require("../src/security/requireAuth");
const { AuthService, InvalidTokenError } = require("../src/application/AuthService");
const { ValidationError } = require("../src/application/CitizenSagaService");
const express = require("express");

const SECRET = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const PASSWORD = "Sup3rSecreta!";
const DOC = 123456789;

let mongoServer;
let secrets;
let clock;
let service;

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

beforeEach(() => {
  secrets = new SecretsManager({ active: SECRET });
  clock = { now: new Date() }; // hora real: los JWT validan `exp` con el reloj del sistema
  service = new AuthService({
    citizenRepository: new CitizenRepository(),
    refreshSessionRepository: new RefreshSessionRepository(),
    secrets,
    auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
    now: () => clock.now,
  });
});

async function createCitizen(overrides = {}) {
  return Citizen.create({
    documento: DOC,
    nombre: "Ana Gomez",
    direccion: "Cra 1",
    correo: "ana@example.com",
    passwordHash: await argon2.hash(PASSWORD),
    direccionUnica: `${DOC}-abcd1234@carpetacolombia.co`,
    estado: "activo",
    ...overrides,
  });
}
const loginOk = () => service.login({ documento: DOC, password: PASSWORD });
const fail = (fn) => fn().catch((e) => e);

describe("AuthService.refresh() -- rotacion de un solo uso", () => {
  test("canjea un refresh token por un par nuevo: access de 15 min, refresh distinto y aun mayor", async () => {
    await createCitizen();
    const first = await loginOk();

    const second = await service.refresh({ refreshToken: first.refreshToken });

    expect(second.expiresIn).toBe(900);
    const access = jwt.decode(second.accessToken);
    expect(access.exp - access.iat).toBe(900);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(jwt.decode(second.refreshToken).jti).not.toBe(jwt.decode(first.refreshToken).jti);
    expect(jwt.decode(second.accessToken).sub).toBe(jwt.decode(first.accessToken).sub);
  });

  test("cada refresh token vale UNA vez: el segundo canje del mismo token se rechaza", async () => {
    await createCitizen();
    const { refreshToken } = await loginOk();

    await service.refresh({ refreshToken });
    const err = await fail(() => service.refresh({ refreshToken }));

    expect(err).toBeInstanceOf(InvalidTokenError);
  });

  test("la cadena sigue funcionando: el token nuevo se puede canjear, y asi sucesivamente", async () => {
    await createCitizen();
    let tokens = await loginOk();

    for (let i = 0; i < 3; i++) tokens = await service.refresh({ refreshToken: tokens.refreshToken });

    expect(tokens.accessToken).toBeTruthy();
  });

  test("REUTILIZACION: presentar un token ya gastado revoca tambien el token nuevo (posible robo)", async () => {
    await createCitizen();
    const stolen = (await loginOk()).refreshToken;
    const legit = await service.refresh({ refreshToken: stolen }); // el dueno renueva

    await fail(() => service.refresh({ refreshToken: stolen })); // el atacante usa el token viejo

    const err = await fail(() => service.refresh({ refreshToken: legit.refreshToken })); // el token nuevo ya no sirve
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect(await RefreshSession.countDocuments({ revokedAt: null })).toBe(0);
  });

  test("la reutilizacion queda en la bitacora, con accion ciudadano.refresh", async () => {
    await createCitizen();
    const { refreshToken } = await loginOk();
    await service.refresh({ refreshToken });
    await fail(() => service.refresh({ refreshToken }));

    const entries = await AuditEntry.find({ action: "ciudadano.refresh" }).sort({ timestamp: 1 }).lean();

    expect(entries.map((e) => [e.outcome, e.reason])).toEqual([["exito", undefined], ["rechazo", "refresh_reutilizado"]]);
    expect(entries[0].actor).toBe(String(DOC));
  });

  test("dos canjes SIMULTANEOS del mismo token: solo uno gana (consumo atomico)", async () => {
    await createCitizen();
    const { refreshToken } = await loginOk();

    const results = await Promise.all(Array.from({ length: 5 }, () => service.refresh({ refreshToken }).catch((e) => e)));

    expect(results.filter((r) => r.accessToken)).toHaveLength(1);
    expect(results.filter((r) => r instanceof InvalidTokenError)).toHaveLength(4);
    // y como hubo reutilizacion, la sesion se revoco: el refresh que se llevo el ganador tampoco sirve
    const winner = results.find((r) => r.refreshToken);
    expect(await fail(() => service.refresh({ refreshToken: winner.refreshToken }))).toBeInstanceOf(InvalidTokenError);
  });

  test("INTERLEAVING FORZADO: si el perdedor revoca ANTES de que el ganador termine de emitir, el token del ganador igual queda invalido", async () => {
    await createCitizen();
    const repo = new RefreshSessionRepository();
    let revoked;
    const revokedFirst = new Promise((resolve) => (revoked = resolve));
    const realRevoke = repo.revokeAllFor.bind(repo);
    repo.revokeAllFor = async (...args) => {
      const n = await realRevoke(...args);
      revoked();
      return n;
    };
    // El ganador consume el token, y su emision se retiene hasta que el perdedor ya haya revocado.
    const realRotate = repo.rotate.bind(repo);
    repo.rotate = async (...args) => {
      const outcome = await realRotate(...args);
      if (outcome.status === "ok") await revokedFirst;
      return outcome;
    };
    const svc = new AuthService({ citizenRepository: new CitizenRepository(), refreshSessionRepository: repo, secrets, now: () => clock.now });
    const { refreshToken } = await svc.login({ documento: DOC, password: PASSWORD });

    const results = await Promise.all([svc.refresh({ refreshToken }).catch((e) => e), svc.refresh({ refreshToken }).catch((e) => e)]);

    const winner = results.find((r) => r.refreshToken);
    expect(winner).toBeDefined(); // el ganador si recibio su par...
    const err = await svc.refresh({ refreshToken: winner.refreshToken }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidTokenError); // ...pero ya no le sirve
  });

  test("la reutilizacion revoca TODAS las sesiones del ciudadano, no solo la afectada (p. ej. otro dispositivo)", async () => {
    await createCitizen();
    const phone = await loginOk();
    const laptop = await loginOk();
    await service.refresh({ refreshToken: phone.refreshToken });

    await fail(() => service.refresh({ refreshToken: phone.refreshToken })); // reutilizacion en el telefono

    expect(await fail(() => service.refresh({ refreshToken: laptop.refreshToken }))).toBeInstanceOf(InvalidTokenError);
    expect(await RefreshSession.countDocuments({ revokedAt: null })).toBe(0);
  });

  test("un refresh token de una sesion ya revocada se rechaza y queda en la bitacora como refresh_revocado", async () => {
    await createCitizen();
    const { refreshToken } = await loginOk();
    const citizen = await Citizen.findOne();
    await new RefreshSessionRepository().revokeAllFor(citizen._id, new Date());

    expect(await fail(() => service.refresh({ refreshToken }))).toBeInstanceOf(InvalidTokenError);
    const entry = await AuditEntry.findOne({ action: "ciudadano.refresh" }).lean();
    expect(entry.reason).toBe("refresh_revocado");
  });

  test("un refresh token sin sesion (sin claim fam) no se canjea", async () => {
    await createCitizen();
    const sub = String((await Citizen.findOne())._id);
    const noFam = secrets.sign({ typ: "refresh" }, { issuer: "ms-identidad", subject: sub, expiresIn: 900, jwtid: "abc" });

    expect(await fail(() => service.refresh({ refreshToken: noFam }))).toBeInstanceOf(InvalidTokenError);
  });
});

describe("AuthService.refresh() -- lo que NO se puede canjear", () => {
  test("un access token no sirve como refresh token", async () => {
    await createCitizen();
    const { accessToken } = await loginOk();

    expect(await fail(() => service.refresh({ refreshToken: accessToken }))).toBeInstanceOf(InvalidTokenError);
  });

  test("basura, firma ajena, otro emisor y token expirado dan el mismo error", async () => {
    await createCitizen();
    const sub = String((await Citizen.findOne())._id);
    const foreign = new SecretsManager({ active: "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAu" }).sign({ typ: "refresh" }, { issuer: "ms-identidad", subject: sub, expiresIn: 900, jwtid: "x" });
    const otherIssuer = secrets.sign({ typ: "refresh" }, { issuer: "otro", subject: sub, expiresIn: 900, jwtid: "y" });
    const expired = secrets.sign({ typ: "refresh" }, { issuer: "ms-identidad", subject: sub, expiresIn: -5, jwtid: "z" });

    for (const token of ["no-es-un-jwt", foreign, otherIssuer, expired]) {
      expect(await fail(() => service.refresh({ refreshToken: token }))).toBeInstanceOf(InvalidTokenError);
    }
  });

  test("el tipo del token se comprueba por si mismo: un token de tipo access con el jti de un refresh REAL tampoco se canjea", async () => {
    await createCitizen();
    const { refreshToken } = await loginOk();
    const { sub, jti } = jwt.decode(refreshToken);
    const disguised = secrets.sign({ typ: "access", fam: jwt.decode(refreshToken).fam }, { issuer: "ms-identidad", subject: sub, expiresIn: 900, jwtid: jti });

    expect(await fail(() => service.refresh({ refreshToken: disguised }))).toBeInstanceOf(InvalidTokenError);
    // y el refresh legitimo sigue sin gastarse: el rechazo fue por tipo, antes de consumirlo
    await expect(service.refresh({ refreshToken })).resolves.toHaveProperty("accessToken");
  });

  test("un refresh token con firma valida pero NUNCA emitido por el servicio no se acepta", async () => {
    await createCitizen();
    const sub = String((await Citizen.findOne())._id);
    const unregistered = secrets.sign({ typ: "refresh", fam: "sesion-nunca-emitida" }, { issuer: "ms-identidad", subject: sub, expiresIn: 900, jwtid: "nunca-emitido" });

    expect(await fail(() => service.refresh({ refreshToken: unregistered }))).toBeInstanceOf(InvalidTokenError);
  });

  test("falta el refreshToken: ValidationError (400)", async () => {
    for (const body of [undefined, {}, { refreshToken: "" }, { refreshToken: 123 }]) {
      await expect(service.refresh(body)).rejects.toThrow(ValidationError);
    }
  });

  test("una cuenta que se bloqueo despues del login no renueva sesion", async () => {
    const citizen = await createCitizen();
    const { refreshToken } = await loginOk();
    await Citizen.updateOne({ _id: citizen._id }, { bloqueadoHasta: new Date(clock.now.getTime() + 60000) });

    expect(await fail(() => service.refresh({ refreshToken }))).toBeInstanceOf(InvalidTokenError);
    const entry = await AuditEntry.findOne({ action: "ciudadano.refresh" }).lean();
    expect(entry.reason).toBe("cuenta_bloqueada");
  });

  test("una cuenta que dejo de estar activa (ej. transferida a otro operador) no renueva sesion", async () => {
    const citizen = await createCitizen();
    const { refreshToken } = await loginOk();
    await Citizen.updateOne({ _id: citizen._id }, { estado: "transferido" });

    expect(await fail(() => service.refresh({ refreshToken }))).toBeInstanceOf(InvalidTokenError);
  });
});

describe("Registro de refresh tokens", () => {
  test("solo se guardan identificadores y la expiracion, nunca el token; expira con el token (indice TTL)", async () => {
    await createCitizen();
    const { refreshToken } = await loginOk();

    const stored = await RefreshSession.findOne().lean();

    expect(stored.currentJti).toBe(jwt.decode(refreshToken).jti);
    expect(stored.familia).toBe(jwt.decode(refreshToken).fam);
    expect(JSON.stringify(stored)).not.toContain(refreshToken);
    expect(Math.abs(stored.expiresAt.getTime() - jwt.decode(refreshToken).exp * 1000)).toBeLessThan(1000); // el JWT trunca a segundos
    await RefreshSession.createIndexes(); // dropDatabase() de otras pruebas borra los indices; se piden de nuevo a Mongo
    const indexes = await RefreshSession.collection.indexes();
    expect(indexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0)).toBe(true);
  });

  test("si no se puede guardar el registro, el login falla en vez de entregar un refresh token inservible", async () => {
    await createCitizen();
    const broken = new AuthService({
      citizenRepository: new CitizenRepository(),
      refreshSessionRepository: { createSession: async () => { throw new Error("mongo caido"); } },
      secrets,
    });

    await expect(broken.login({ documento: DOC, password: PASSWORD })).rejects.toThrow("mongo caido");
  });
});

describe("POST /api/v1/auth/refresh (HTTP)", () => {
  let app;
  beforeEach(() => {
    app = buildApp({ citizenSagaService: {}, authService: service, secrets });
  });
  const refresh = (body) => request(app).post("/api/v1/auth/refresh").send(body);
  const login = () => request(app).post("/api/v1/auth/login").send({ documento: DOC, password: PASSWORD });

  test("200 con el par nuevo, sin cache; el access token nuevo abre la API", async () => {
    await createCitizen();
    const { body: first } = await login().expect(200);

    const res = await refresh({ refreshToken: first.refreshToken }).expect(200);

    expect(Object.keys(res.body).sort()).toEqual(["accessToken", "expiresIn", "refreshToken"]);
    expect(res.headers["cache-control"]).toBe("no-store");
    await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`).expect(200);
  });

  test("401 generico al reusar el token, y 400 si falta", async () => {
    await createCitizen();
    const { body: first } = await login().expect(200);
    await refresh({ refreshToken: first.refreshToken }).expect(200);

    const reused = await refresh({ refreshToken: first.refreshToken });

    expect(reused.status).toBe(401);
    expect(reused.body).toEqual({ error: "token invalido o expirado" });
    await refresh({}).expect(400);
  });

  test("el refresh token NO abre la API: el middleware exige access token", async () => {
    await createCitizen();
    const { body: first } = await login().expect(200);

    await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${first.refreshToken}`).expect(401);
  });

  test("otro microservicio tampoco acepta un refresh token como credencial", async () => {
    await createCitizen();
    const { body: first } = await login().expect(200);
    const other = express();
    other.get("/documentos", requireAuth(new SecretsManager({ active: SECRET })), (_req, res) => res.json({ ok: true }));

    await request(other).get("/documentos").set("Authorization", `Bearer ${first.refreshToken}`).expect(401);
  });
});
