const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Institution = require("../src/domain/Institution");
const AuditEntry = require("../src/domain/AuditEntry");
const { InstitutionRepository } = require("../src/infrastructure/InstitutionRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const SecretsManager = require("../src/security/SecretsManager");
const logger = require("../src/tracing/logger");
const { InstitutionService } = require("../src/application/InstitutionService");
const { EntityAuthService, InvalidCredentialsError } = require("../src/application/EntityAuthService");

// Llaves de prueba. ENTIDAD y CIUDADANO son DISTINTAS a proposito: es justo lo que ADR-07 separa.
const ENTITY_SECRET = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const CITIZEN_SECRET = "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAu";
const PASSWORD = "Clave-institucional-123";
const valid = { nombre: "Universidad EAFIT", tipo: "universidad", nit: "890.901.389-5", correoContacto: "registro@eafit.edu.co" };

let mongoServer;
let repository;
let institutions;
let auth;

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
  repository = new InstitutionRepository();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  institutions = new InstitutionService({ institutionRepository: repository, auditLogger });
  auth = new EntityAuthService({ institutionRepository: repository, secrets: new SecretsManager({ active: ENTITY_SECRET }), auditLogger });
});

const registerWithPassword = (overrides = {}) => institutions.register({ ...valid, password: PASSWORD, ...overrides });
const decode = (token) => jwt.verify(token, ENTITY_SECRET, { algorithms: ["HS256"] });

describe("EntityAuthService.authenticate() -- login institucional (ADR-07)", () => {
  test("credenciales correctas -> access token institucional de 15 minutos, sin refresh token", async () => {
    const { institutionId } = await registerWithPassword();

    const res = await auth.authenticate({ nit: valid.nit, password: PASSWORD });

    expect(Object.keys(res).sort()).toEqual(["accessToken", "expiresIn", "tokenType"]);
    expect(res.tokenType).toBe("Bearer");
    expect(res.expiresIn).toBe(900);
    const payload = decode(res.accessToken);
    expect(payload).toMatchObject({ sub: institutionId, iss: "ms-comparticion", typ: "access", act: "entidad" });
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.exp - payload.iat).toBe(900);
  });

  test("el token representa a una INSTITUCION: no lleva ciudadanoId ni datos personales de la entidad", async () => {
    await registerWithPassword();
    const { accessToken } = await auth.authenticate({ nit: valid.nit, password: PASSWORD });

    const payload = decode(accessToken);
    expect(payload).not.toHaveProperty("ciudadanoId");
    expect(JSON.stringify(payload)).not.toMatch(/890901389|eafit\.edu\.co|Universidad/);
  });

  test("el token se firma con ENTITY_JWT_SECRET y NO con la llave de ciudadanos", async () => {
    await registerWithPassword();

    const { accessToken } = await auth.authenticate({ nit: valid.nit, password: PASSWORD });

    expect(() => jwt.verify(accessToken, ENTITY_SECRET, { algorithms: ["HS256"] })).not.toThrow();
    expect(() => jwt.verify(accessToken, CITIZEN_SECRET, { algorithms: ["HS256"] })).toThrow(jwt.JsonWebTokenError);
    // El `kid` es el de la llave de entidades: un llavero de ciudadanos no reconoce siquiera cual llave usar.
    const kid = jwt.decode(accessToken, { complete: true }).header.kid;
    expect(kid).toBe(new SecretsManager({ active: ENTITY_SECRET }).status().activeKid);
    expect(kid).not.toBe(new SecretsManager({ active: CITIZEN_SECRET }).status().activeKid);
  });

  test("contrasena incorrecta -> siempre el MISMO error, y no emite token", async () => {
    await registerWithPassword();

    await expect(auth.authenticate({ nit: valid.nit, password: "otra-clave-distinta" })).rejects.toThrow(InvalidCredentialsError);
  });

  test("institucion inexistente -> el mismo error que una contrasena mala (no se puede enumerar)", async () => {
    await registerWithPassword();

    const noExiste = await auth.authenticate({ nit: "899999068", password: PASSWORD }).catch((e) => e);
    const malaClave = await auth.authenticate({ nit: valid.nit, password: "otra-clave-distinta" }).catch((e) => e);

    expect(noExiste).toBeInstanceOf(InvalidCredentialsError);
    expect(noExiste.message).toBe(malaClave.message);
  });

  test("entidad registrada SIN contrasena: no puede autenticarse, con el mismo error generico", async () => {
    await institutions.register(valid); // HU-06.1 tal cual: sin credencial

    await expect(auth.authenticate({ nit: valid.nit, password: PASSWORD })).rejects.toThrow(InvalidCredentialsError);
  });

  test.each([
    ["NIT ausente", { password: PASSWORD }],
    ["NIT mal formado", { nit: "basura", password: PASSWORD }],
    ["contrasena ausente", { nit: valid.nit }],
    ["contrasena vacia", { nit: valid.nit, password: "" }],
    ["contrasena enorme (no se le pasa a Argon2)", { nit: valid.nit, password: "x".repeat(2000) }],
    ["entrada que no es objeto", undefined],
  ])("%s -> InvalidCredentialsError, nunca un error interno", async (_name, input) => {
    await registerWithPassword();
    await expect(auth.authenticate(input)).rejects.toThrow(InvalidCredentialsError);
  });

  test("el NIT se acepta en cualquiera de sus formas (con/sin puntos, con/sin digito de verificacion)", async () => {
    await registerWithPassword();

    for (const nit of ["890.901.389-5", "890901389", "890901389-5", "890.901.389"]) {
      await expect(auth.authenticate({ nit, password: PASSWORD })).resolves.toHaveProperty("accessToken");
    }
  });

  test("la contrasena se guarda con Argon2id, nunca en claro", async () => {
    const { institutionId } = await registerWithPassword();

    const doc = await Institution.findById(institutionId).lean();
    expect(doc.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(doc)).not.toContain(PASSWORD);
  });

  test("un resumen que NO es Argon2id no autentica, aunque la contrasena sea correcta", async () => {
    const { institutionId } = await registerWithPassword();
    const argon2 = require("argon2");
    // Se fuerza un resumen argon2i (otra variante): la politica es Argon2id (ADR-06).
    await Institution.updateOne({ _id: institutionId }, { passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2i }) });

    await expect(auth.authenticate({ nit: valid.nit, password: PASSWORD })).rejects.toThrow(InvalidCredentialsError);
  });
});

describe("Fuerza bruta: misma politica que el login del ciudadano (HU-02)", () => {
  test("al 5.o intento fallido la entidad queda bloqueada, y ni la contrasena correcta entra", async () => {
    await registerWithPassword();

    for (let i = 0; i < 5; i++) await auth.authenticate({ nit: valid.nit, password: "mala" }).catch(() => {});

    const doc = await Institution.findOne({ nit: "890901389" }).lean();
    expect(doc.intentosFallidos).toBeGreaterThanOrEqual(5);
    expect(doc.bloqueadoHasta).toBeInstanceOf(Date);
    await expect(auth.authenticate({ nit: valid.nit, password: PASSWORD })).rejects.toThrow(InvalidCredentialsError);
  });

  test("durante el bloqueo NO se cuentan mas intentos (un atacante no puede bloquear para siempre)", async () => {
    await registerWithPassword();
    for (let i = 0; i < 5; i++) await auth.authenticate({ nit: valid.nit, password: "mala" }).catch(() => {});
    const trasBloqueo = (await Institution.findOne({ nit: "890901389" }).lean()).intentosFallidos;

    await auth.authenticate({ nit: valid.nit, password: "mala" }).catch(() => {});

    expect((await Institution.findOne({ nit: "890901389" }).lean()).intentosFallidos).toBe(trasBloqueo);
  });

  test("vencido el bloqueo se empieza de cero y la contrasena correcta entra", async () => {
    await registerWithPassword();
    for (let i = 0; i < 5; i++) await auth.authenticate({ nit: valid.nit, password: "mala" }).catch(() => {});

    // Un servicio que "vive" 20 minutos despues: el bloqueo de 15 minutos ya vencio.
    const later = new EntityAuthService({
      institutionRepository: repository,
      secrets: new SecretsManager({ active: ENTITY_SECRET }),
      now: () => new Date(Date.now() + 20 * 60 * 1000),
    });

    await expect(later.authenticate({ nit: valid.nit, password: PASSWORD })).resolves.toHaveProperty("accessToken");
    expect((await Institution.findOne({ nit: "890901389" }).lean()).intentosFallidos).toBe(0);
  });

  test("CONCURRENCIA: 8 intentos fallidos simultaneos se cuentan los 8 (actualizacion atomica)", async () => {
    await registerWithPassword();

    await Promise.all(Array.from({ length: 8 }, () => auth.authenticate({ nit: valid.nit, password: "mala" }).catch(() => {})));

    expect((await Institution.findOne({ nit: "890901389" }).lean()).intentosFallidos).toBe(8);
  });

  test("un login exitoso deja el contador en cero", async () => {
    await registerWithPassword();
    await auth.authenticate({ nit: valid.nit, password: "mala" }).catch(() => {});

    await auth.authenticate({ nit: valid.nit, password: PASSWORD });

    expect((await Institution.findOne({ nit: "890901389" }).lean()).intentosFallidos).toBe(0);
  });
});

describe("verificada: decision documentada (ADR-07)", () => {
  test("una entidad NO verificada SI puede autenticarse: hoy nada pone verificada:true y exigirlo dejaria a todas fuera", async () => {
    const { institutionId } = await registerWithPassword();
    expect((await Institution.findById(institutionId).lean()).verificada).toBe(false);

    await expect(auth.authenticate({ nit: valid.nit, password: PASSWORD })).resolves.toHaveProperty("accessToken");
  });

  test("el token lleva `ver` con el estado de verificacion, para que HU-10/HU-06.3 puedan exigirlo al AUTORIZAR", async () => {
    const { institutionId } = await registerWithPassword();

    const sinVerificar = decode((await auth.authenticate({ nit: valid.nit, password: PASSWORD })).accessToken);
    expect(sinVerificar.ver).toBe(false);

    await Institution.updateOne({ _id: institutionId }, { verificada: true }); // lo haria un proceso de verificacion futuro
    const verificada = decode((await auth.authenticate({ nit: valid.nit, password: PASSWORD })).accessToken);
    expect(verificada.ver).toBe(true);
  });
});

describe("Bitacora (HT-04) y logs", () => {
  test("cada intento queda en la bitacora como accion de la entidad, con su resultado", async () => {
    const { institutionId } = await registerWithPassword();

    await auth.authenticate({ nit: valid.nit, password: PASSWORD });
    await auth.authenticate({ nit: valid.nit, password: "mala" }).catch(() => {});

    const exito = await AuditEntry.findOne({ action: "institucion.autenticar", outcome: "exito" }).lean();
    expect(exito).toMatchObject({ actor: "890901389", actorType: "entidad", resource: `institucion:${institutionId}`, resourceOwner: "890901389" });
    const fallo = await AuditEntry.findOne({ action: "institucion.autenticar", outcome: "fallo" }).lean();
    expect(fallo.reason).toBe("credencial_incorrecta");
  });

  test("un NIT no registrado queda auditado como fallo (nit_no_registrado)", async () => {
    await auth.authenticate({ nit: "899999068", password: PASSWORD }).catch(() => {});

    const entry = await AuditEntry.findOne({ action: "institucion.autenticar" }).lean();
    expect(entry).toMatchObject({ outcome: "fallo", reason: "nit_no_registrado" });
  });

  test("la autenticacion no queda como violacion de RNF-07: actor y dueno del recurso coinciden", async () => {
    await registerWithPassword();
    await auth.authenticate({ nit: valid.nit, password: PASSWORD });

    const entry = await AuditEntry.findOne({ action: "institucion.autenticar", outcome: "exito" }).lean();
    expect(entry.actor).toBe(entry.resourceOwner);
    expect(entry.delegated).toBe(false);
  });

  test("ni la contrasena ni el NIT ni el token aparecen en los logs", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));
    await registerWithPassword();
    const { accessToken } = await auth.authenticate({ nit: valid.nit, password: PASSWORD });
    await auth.authenticate({ nit: valid.nit, password: "mala" }).catch(() => {});

    const dump = lines.join("\n");
    for (const secreto of [PASSWORD, "890901389", accessToken, ENTITY_SECRET]) expect(dump).not.toContain(secreto);
  });

  test("si la bitacora falla, la autenticacion ya resuelta no se cae", async () => {
    await registerWithPassword();
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));
    const s = new EntityAuthService({
      institutionRepository: repository,
      secrets: new SecretsManager({ active: ENTITY_SECRET }),
      auditLogger: { record: async () => { throw new Error("mongo caido"); } },
    });

    await expect(s.authenticate({ nit: valid.nit, password: PASSWORD })).resolves.toHaveProperty("accessToken");
    expect(lines.join("\n")).toContain("audit.write_failed");
  });
});
