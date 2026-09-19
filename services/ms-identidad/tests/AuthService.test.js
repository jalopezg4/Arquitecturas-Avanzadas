const argon2 = require("argon2");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Citizen = require("../src/domain/Citizen");
const AuditEntry = require("../src/domain/AuditEntry");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const RefreshSessionRepository = require("../src/infrastructure/RefreshSessionRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const SecretsManager = require("../src/security/SecretsManager");
const logger = require("../src/tracing/logger");
const { AuthService, InvalidCredentialsError } = require("../src/application/AuthService");
const { ValidationError } = require("../src/application/CitizenSagaService");

const SECRET = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const PASSWORD = "Sup3rSecreta!";
const DOC = 123456789;

let mongoServer;
let secrets;
let repo;
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

beforeEach(() => {
  secrets = new SecretsManager({ active: SECRET });
  repo = new CitizenRepository();
  clock = { now: new Date("2026-09-20T10:00:00Z") };
  service = new AuthService({
    citizenRepository: repo,
    refreshSessionRepository: new RefreshSessionRepository(),
    secrets,
    auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
    now: () => clock.now,
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await mongoose.connection.dropDatabase();
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

const reload = () => Citizen.findOne({ documento: DOC }).lean();
const failLogin = (password = "incorrecta") => service.login({ documento: DOC, password }).catch((e) => e);

describe("AuthService.login() -- credenciales y tokens", () => {
  test("verifica el password con Argon2id (no bcrypt) contra el resumen almacenado", async () => {
    const citizen = await createCitizen();
    const verify = jest.spyOn(argon2, "verify");

    await service.login({ documento: DOC, password: PASSWORD });

    expect(citizen.passwordHash).toMatch(/^\$argon2id\$/);
    expect(verify).toHaveBeenCalledWith(citizen.passwordHash, PASSWORD);
  });

  test("emite access token de 15 minutos y refresh token de mayor vigencia, con la respuesta {accessToken, refreshToken, expiresIn: 900}", async () => {
    const citizen = await createCitizen();

    const res = await service.login({ documento: String(DOC), password: PASSWORD }); // documento como cadena tambien vale

    expect(Object.keys(res).sort()).toEqual(["accessToken", "expiresIn", "refreshToken"]);
    expect(res.expiresIn).toBe(900);
    const access = jwt.decode(res.accessToken);
    const refresh = jwt.decode(res.refreshToken);
    expect(access.exp - access.iat).toBe(900);
    expect(refresh.exp - refresh.iat).toBe(7 * 24 * 3600);
    expect(refresh.exp).toBeGreaterThan(access.exp);
    expect([access.typ, refresh.typ]).toEqual(["access", "refresh"]);
    expect(access.sub).toBe(String(citizen._id));
    expect(access.iss).toBe("ms-identidad");
    expect(access.jti).not.toBe(refresh.jti);
    // los dos los puede verificar el llavero (firma valida, aun no expirados)
    expect(() => secrets.verify(res.accessToken)).not.toThrow();
    expect(() => secrets.verify(res.refreshToken)).not.toThrow();
  });

  test("el token NO contiene documento, password ni resumen (un JWT solo esta firmado, no cifrado)", async () => {
    await createCitizen();

    const res = await service.login({ documento: DOC, password: PASSWORD });

    for (const token of [res.accessToken, res.refreshToken]) {
      const body = JSON.stringify(jwt.decode(token));
      expect(body).not.toContain(String(DOC));
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toContain("argon2");
    }
  });

  test("respeta la vigencia configurada (no la fija en el codigo)", async () => {
    await createCitizen();
    const custom = new AuthService({ citizenRepository: repo, refreshSessionRepository: new RefreshSessionRepository(), secrets, accessExpiresIn: "10m", refreshExpiresIn: "1d" });

    const res = await custom.login({ documento: DOC, password: PASSWORD });

    expect(res.expiresIn).toBe(600);
    expect(jwt.decode(res.refreshToken).exp - jwt.decode(res.refreshToken).iat).toBe(86400);
  });
});

describe("AuthService.login() -- rechazo generico (no revela si el documento existe)", () => {
  test("responde con el mismo error si el password no coincide o si el documento no existe", async () => {
    await createCitizen();

    const badPassword = await failLogin();
    const unknown = await service.login({ documento: 999000111, password: PASSWORD }).catch((e) => e);

    expect(badPassword).toBeInstanceOf(InvalidCredentialsError);
    expect(unknown).toBeInstanceOf(InvalidCredentialsError);
    expect(unknown.message).toBe(badPassword.message);
    expect(badPassword.message).toBe("credenciales invalidas");
  });

  test("el documento inexistente tambien ejecuta una verificacion Argon2 (tiempo uniforme, no se enumera por latencia)", async () => {
    const verify = jest.spyOn(argon2, "verify");

    await service.login({ documento: 999000111, password: PASSWORD }).catch(() => {});

    expect(verify).toHaveBeenCalledTimes(1);
  });

  test("cuenta no activa y password mala dan el MISMO mensaje", async () => {
    await createCitizen({ estado: "pendiente" });
    const pending = await service.login({ documento: DOC, password: PASSWORD }).catch((e) => e);
    const wrong = await failLogin();

    expect(pending).toBeInstanceOf(InvalidCredentialsError);
    expect(pending.message).toBe(wrong.message);
  });

  test.each(["pendiente", "transferido"])("un ciudadano en estado %s no puede iniciar sesion aunque el password sea correcto, y no suma intentos", async (estado) => {
    await createCitizen({ estado });

    await expect(service.login({ documento: DOC, password: PASSWORD })).rejects.toThrow(InvalidCredentialsError);

    expect((await reload()).intentosFallidos).toBe(0);
    const entry = await AuditEntry.findOne({ action: "ciudadano.login" }).lean();
    expect([entry.outcome, entry.reason]).toEqual(["rechazo", `estado_${estado}`]);
  });

  test("entradas mal formadas son ValidationError (400), no un intento de autenticacion", async () => {
    await createCitizen();
    const verify = jest.spyOn(argon2, "verify");

    for (const body of [undefined, {}, { documento: DOC }, { password: PASSWORD }, { documento: "abc", password: PASSWORD }, { documento: DOC, password: "" }, { documento: DOC, password: 12345678 }, { documento: DOC, password: "x".repeat(1025) }, { documento: { $gt: 0 }, password: PASSWORD }]) {
      await expect(service.login(body)).rejects.toThrow(ValidationError);
    }
    expect(verify).not.toHaveBeenCalled();
    expect((await reload()).intentosFallidos).toBe(0);
  });
});

describe("AuthService.login() -- hallazgos de la revision (concurrencia y variante de Argon2)", () => {
  test("un login correcto que EMPEZO desbloqueado no entra si la cuenta se bloquea mientras se verifica el password", async () => {
    const citizen = await createCitizen();
    const realVerify = argon2.verify;
    // Simula los 5 intentos concurrentes: la cuenta se bloquea justo durante la verificacion Argon2 de este login.
    jest.spyOn(argon2, "verify").mockImplementation(async (...args) => {
      await Citizen.updateOne({ _id: citizen._id }, { bloqueadoHasta: new Date(clock.now.getTime() + 10 * 60 * 1000), intentosFallidos: 5 });
      return realVerify(...args);
    });

    const err = await service.login({ documento: DOC, password: PASSWORD }).catch((e) => e);

    expect(err).toBeInstanceOf(InvalidCredentialsError);
    const entry = await AuditEntry.findOne({ action: "ciudadano.login" }).lean();
    expect([entry.outcome, entry.reason]).toEqual(["rechazo", "cuenta_bloqueada"]);
    expect(await require("../src/domain/RefreshSession").countDocuments()).toBe(0); // ni siquiera se abrio una sesion
  });

  test("lo mismo si la cuenta deja de estar activa durante la verificacion", async () => {
    const citizen = await createCitizen();
    const realVerify = argon2.verify;
    jest.spyOn(argon2, "verify").mockImplementation(async (...args) => {
      await Citizen.updateOne({ _id: citizen._id }, { estado: "transferido" });
      return realVerify(...args);
    });

    await expect(service.login({ documento: DOC, password: PASSWORD })).rejects.toThrow(InvalidCredentialsError);
    expect((await AuditEntry.findOne({ action: "ciudadano.login" }).lean()).reason).toBe("estado_transferido");
  });

  test.each([
    ["argon2i", { type: argon2.argon2i }],
    ["argon2d", { type: argon2.argon2d }],
  ])("un resumen %s (no Argon2id) NO autentica aunque el password sea correcto", async (_name, options) => {
    await createCitizen({ passwordHash: await argon2.hash(PASSWORD, options) });

    const err = await service.login({ documento: DOC, password: PASSWORD }).catch((e) => e);

    expect(err).toBeInstanceOf(InvalidCredentialsError);
    expect(err.message).toBe("credenciales invalidas"); // misma respuesta: no se revela el motivo
    expect((await AuditEntry.findOne({ action: "ciudadano.login" }).lean()).reason).toBe("resumen_no_argon2id");
  });

  test("con un resumen no Argon2id igual se hace una verificacion (tiempo uniforme) pero NUNCA contra ese resumen", async () => {
    const legacy = await argon2.hash(PASSWORD, { type: argon2.argon2i });
    await createCitizen({ passwordHash: legacy });
    const verify = jest.spyOn(argon2, "verify");

    await service.login({ documento: DOC, password: PASSWORD }).catch(() => {});

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalledWith(legacy, expect.anything());
  });
});

describe("AuthService.login() -- contador de intentos y bloqueo", () => {
  test("incrementa el contador de intentos fallidos del ciudadano", async () => {
    await createCitizen();

    await failLogin();
    expect((await reload()).intentosFallidos).toBe(1);
    await failLogin();
    expect((await reload()).intentosFallidos).toBe(2);
  });

  test("bloquea la cuenta al 5o intento fallido (con 4 aun no)", async () => {
    await createCitizen();

    for (let i = 0; i < 4; i++) await failLogin();
    let c = await reload();
    expect(c.intentosFallidos).toBe(4);
    expect(c.bloqueadoHasta).toBeNull();

    await failLogin(); // 5o
    c = await reload();
    expect(c.bloqueadoHasta).not.toBeNull();
    expect(c.bloqueadoHasta.getTime()).toBe(clock.now.getTime() + 15 * 60 * 1000);
  });

  test("un intento con password CORRECTO tambien se rechaza mientras dure el bloqueo, sin sumar intentos ni extender el bloqueo", async () => {
    await createCitizen();
    for (let i = 0; i < 5; i++) await failLogin();
    const locked = await reload();

    clock.now = new Date(clock.now.getTime() + 5 * 60 * 1000); // pasaron 5 de 15 minutos
    const withCorrect = await service.login({ documento: DOC, password: PASSWORD }).catch((e) => e);
    await failLogin();

    expect(withCorrect).toBeInstanceOf(InvalidCredentialsError);
    const after = await reload();
    expect(after.intentosFallidos).toBe(locked.intentosFallidos);
    expect(after.bloqueadoHasta.getTime()).toBe(locked.bloqueadoHasta.getTime());
  });

  test("cuando el bloqueo vence se puede entrar, y el contador vuelve a cero", async () => {
    await createCitizen();
    for (let i = 0; i < 5; i++) await failLogin();

    clock.now = new Date(clock.now.getTime() + 15 * 60 * 1000 + 1);
    const res = await service.login({ documento: DOC, password: PASSWORD });

    expect(res.accessToken).toBeTruthy();
    const c = await reload();
    expect(c.intentosFallidos).toBe(0);
    expect(c.bloqueadoHasta).toBeNull();
  });

  test("tras vencer el bloqueo, un fallo cuenta como el 1o (no vuelve a bloquear de inmediato)", async () => {
    await createCitizen();
    for (let i = 0; i < 5; i++) await failLogin();

    clock.now = new Date(clock.now.getTime() + 15 * 60 * 1000 + 1);
    await failLogin();

    const c = await reload();
    expect(c.intentosFallidos).toBe(1);
    expect(c.bloqueadoHasta).toBeNull();
  });

  test("un login exitoso reinicia el contador de intentos", async () => {
    await createCitizen();
    for (let i = 0; i < 3; i++) await failLogin();

    await service.login({ documento: DOC, password: PASSWORD });

    expect((await reload()).intentosFallidos).toBe(0);
  });

  test("intentos EN PARALELO no se pierden: 8 fallos simultaneos cuentan 8 y dejan la cuenta bloqueada (contador atomico)", async () => {
    await createCitizen();

    await Promise.all(Array.from({ length: 8 }, () => failLogin()));

    const c = await reload();
    expect(c.intentosFallidos).toBe(8);
    expect(c.bloqueadoHasta).not.toBeNull();
  });

  test("el bloqueo es por ciudadano: no afecta a otros", async () => {
    await createCitizen();
    const otherPass = "OtraClave123!";
    await createCitizen({ documento: 222, direccionUnica: "222-x@carpetacolombia.co", passwordHash: await argon2.hash(otherPass) });
    for (let i = 0; i < 5; i++) await failLogin();

    const res = await service.login({ documento: 222, password: otherPass });

    expect(res.accessToken).toBeTruthy();
  });
});

describe("AuditLogger.record() -- bitacora de accesos (HT-04)", () => {
  test("persiste el login exitoso y los fallidos con ciudadano, timestamp y resultado", async () => {
    await createCitizen();
    await failLogin();
    await service.login({ documento: DOC, password: PASSWORD });

    const entries = await AuditEntry.find({ action: "ciudadano.login" }).sort({ timestamp: 1 }).lean();

    expect(entries.map((e) => [e.outcome, e.reason])).toEqual([["fallo", "password_incorrecto"], ["exito", undefined]]);
    for (const e of entries) {
      expect(e.actor).toBe(String(DOC));
      expect(e.actorType).toBe("ciudadano");
      expect(e.timestamp).toBeInstanceOf(Date);
    }
  });

  test("registra tambien documento inexistente y cuenta bloqueada, con su razon", async () => {
    await createCitizen();
    await service.login({ documento: 555, password: PASSWORD }).catch(() => {});
    for (let i = 0; i < 5; i++) await failLogin();
    await failLogin();

    const reasons = (await AuditEntry.find({ action: "ciudadano.login" }).lean()).map((e) => e.reason);

    expect(reasons).toContain("documento_no_registrado");
    expect(reasons).toContain("cuenta_bloqueada");
    const last = await AuditEntry.findOne({ action: "ciudadano.login", reason: "password_incorrecto" }).sort({ timestamp: -1 }).lean();
    expect(last.metadata).toMatchObject({ intentosFallidos: 5, bloqueada: true });
  });

  test("la bitacora nunca guarda el password ni el resumen", async () => {
    await createCitizen();
    await failLogin("miClaveIntentada99");
    await service.login({ documento: DOC, password: PASSWORD });

    const dump = JSON.stringify(await AuditEntry.find().lean());

    expect(dump).not.toContain("miClaveIntentada99");
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain("argon2");
  });

  test("si la bitacora falla, el login no se cae (mismo criterio que el registro) pero el error se reporta", async () => {
    await createCitizen();
    const lines = [];
    logger.setSink((l) => lines.push(l));
    const flaky = new AuthService({
      citizenRepository: repo,
      refreshSessionRepository: new RefreshSessionRepository(),
      secrets,
      auditLogger: { record: async () => { throw new Error("mongo caido"); } },
    });

    const res = await flaky.login({ documento: DOC, password: PASSWORD });
    logger.resetSink();

    expect(res.accessToken).toBeTruthy();
    expect(lines.join("\n")).toContain("audit.write_failed");
  });
});

describe("AuthService -- higiene de logs", () => {
  test("ningun log contiene el password, el documento ni el resumen", async () => {
    await createCitizen();
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));

    for (let i = 0; i < 5; i++) await failLogin("intentoSecreto77");
    await service.login({ documento: 404, password: "otroSecreto88" }).catch(() => {});
    logger.resetSink();

    const dump = lines.join("\n");
    expect(dump).toContain("auth.cuenta_bloqueada"); // si hubo logs que revisar
    for (const forbidden of ["intentoSecreto77", "otroSecreto88", String(DOC), "argon2"]) expect(dump).not.toContain(forbidden);
  });
});
