/**
 * ADR-07 en ms-documentos: PREPARACION para HU-10, no HU-10.
 *
 * Aqui todavia no hay ninguna ruta de entidad montada (la carga y la consulta siguen siendo solo del ciudadano).
 * Lo que se comprueba es que los dos mundos ya estan separados y que la bitacora admite el caso delegado que
 * HU-10 va a necesitar: actor = entidad, dueno del recurso = ciudadano, delegated = true.
 */
const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const SecretsManager = require("../src/security/SecretsManager");
const requireAuth = require("../src/security/requireAuth");
const requireEntityAuth = require("../src/security/requireEntityAuth");
const AuditEntry = require("../src/domain/AuditEntry");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const { validateConfig } = require("../src/config/ConfigValidator");

const CITIZEN_SECRET = "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAu";
const ENTITY_SECRET = "Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A";
const citizenSecrets = new SecretsManager({ active: CITIZEN_SECRET });
const entitySecrets = new SecretsManager({ active: ENTITY_SECRET });

const CIUDADANO = "665f1c04c9de9c4c34f6b52a";
const INSTITUCION = "6aae9153b7655900026073f1";

const citizenToken = (claims = {}, options = {}) =>
  citizenSecrets.sign({ typ: "access", ...claims }, { issuer: "ms-identidad", subject: CIUDADANO, expiresIn: 900, ...options });
const entityToken = (claims = {}, options = {}, keyRing = entitySecrets) =>
  keyRing.sign({ typ: "access", act: "entidad", ...claims }, { issuer: "ms-comparticion", subject: INSTITUCION, expiresIn: 900, ...options });

/** App minima con una ruta por cada tipo de actor, para comprobar que ninguna acepta el token de la otra. */
function appWithBothGuards() {
  const app = express();
  app.get("/ciudadano", requireAuth(citizenSecrets, { issuer: "ms-identidad" }), (req, res) => res.status(200).json(req.auth));
  app.get("/entidad", requireEntityAuth(entitySecrets), (req, res) => res.status(200).json(req.auth));
  return app;
}

describe("Separacion de actores: ciudadano y entidad no se cruzan", () => {
  const app = appWithBothGuards();

  test("el token de ciudadano abre la ruta de ciudadano y deja req.auth.ciudadanoId (HU-03/HU-08 intactas)", async () => {
    const res = await request(app).get("/ciudadano").set("Authorization", `Bearer ${citizenToken()}`).expect(200);

    expect(res.body).toMatchObject({ ciudadanoId: CIUDADANO });
    expect(res.body).not.toHaveProperty("institutionId");
  });

  test("el token institucional abre la ruta de entidad y deja req.auth.institutionId, NUNCA ciudadanoId", async () => {
    const res = await request(app).get("/entidad").set("Authorization", `Bearer ${entityToken()}`).expect(200);

    expect(res.body).toMatchObject({ institutionId: INSTITUCION, actorType: "entidad", verificada: false });
    expect(res.body).not.toHaveProperty("ciudadanoId");
  });

  test("requireAuth (ciudadano) RECHAZA un token institucional: ni su llave ni su emisor coinciden", async () => {
    for (const token of [entityToken(), entityToken({ act: undefined }), entityToken({}, { issuer: "ms-identidad" })]) {
      const res = await request(app).get("/ciudadano").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "token invalido o expirado" });
    }
  });

  test("requireEntityAuth RECHAZA un token de ciudadano, aunque imite los claims institucionales", async () => {
    const imitador = citizenSecrets.sign({ typ: "access", act: "entidad" }, { issuer: "ms-comparticion", subject: INSTITUCION, expiresIn: 900 });

    for (const token of [citizenToken(), citizenToken({ act: "entidad" }), imitador]) {
      await request(app).get("/entidad").set("Authorization", `Bearer ${token}`).expect(401);
    }
  });

  test("401 con token institucional expirado, sin `act` o sin subject", async () => {
    const sinSub = entitySecrets.sign({ typ: "access", act: "entidad" }, { issuer: "ms-comparticion", expiresIn: 900 });

    for (const token of [entityToken({}, { expiresIn: -10 }), entityToken({ act: undefined }), entityToken({ typ: "refresh" }), sinSub]) {
      await request(app).get("/entidad").set("Authorization", `Bearer ${token}`).expect(401);
    }
  });

  test("sin llavero institucional la ruta de entidad falla cerrado (401)", async () => {
    const sinLlave = express();
    sinLlave.get("/entidad", requireEntityAuth(null), (_req, res) => res.status(200).json({ ok: true }));

    await request(sinLlave).get("/entidad").set("Authorization", `Bearer ${entityToken()}`).expect(401);
  });
});

describe("Configuracion (ADR-07): la llave de entidades es opcional aqui, pero nunca puede ser la de ciudadanos", () => {
  const base = {
    isLocal: true,
    jwtSecret: CITIZEN_SECRET,
    s3: { bucket: "carpeta-documentos", connectTimeoutMs: 1500, requestTimeoutMs: 2500 },
    limits: { quotaNoCertificados: 5, maxUploadBytes: 1024 },
    presignedDownloadTtlSeconds: 3600,
    tls: {},
  };

  test("sin ENTITY_JWT_SECRET la configuracion sigue siendo valida (ninguna ruta la usa todavia)", () => {
    expect(validateConfig(base)).toEqual([]);
  });

  test("si se define, debe ser distinta de JWT_SECRET", () => {
    expect(validateConfig({ ...base, entityJwtSecret: ENTITY_SECRET })).toEqual([]);
    expect(validateConfig({ ...base, entityJwtSecret: CITIZEN_SECRET }).join()).toContain("no puede ser igual a JWT_SECRET");
  });

  test("fuera de local, si se define debe ser fuerte", () => {
    const prod = { ...base, isLocal: false, rabbitUri: "amqps://x", mongoUri: "mongodb+srv://a:Zq8mV2nX9pLr@c/x", s3: { ...base.s3, endpoint: "https://s3", accessKeyId: "AKIAX", secretAccessKey: "s3cr3t0-largo-aleatorio" } };

    expect(validateConfig({ ...prod, entityJwtSecret: "corta" }).join()).toContain("ENTITY_JWT_SECRET");
    expect(validateConfig({ ...prod, entityJwtSecret: ENTITY_SECRET }).join()).not.toContain("ENTITY_JWT_SECRET");
  });
});

describe("Bitacora: el caso delegado que HU-10 va a necesitar ya es posible (HT-04, RNF-07)", () => {
  let mongoServer;
  let auditLogger;

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
    auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  });

  test("se puede registrar una accion de ENTIDAD sobre la carpeta de un CIUDADANO, marcada como delegada", async () => {
    await auditLogger.record({
      actor: INSTITUCION,
      actorType: "entidad",
      action: "documento.recibir",
      resource: `carpeta:${CIUDADANO}`,
      resourceOwner: CIUDADANO,
      delegated: true,
      outcome: "exito",
    });

    const entry = await AuditEntry.findOne({ action: "documento.recibir" }).lean();
    expect(entry).toMatchObject({ actor: INSTITUCION, actorType: "entidad", resourceOwner: CIUDADANO, delegated: true, outcome: "exito" });
  });

  test("la misma accion SIN delegated seria un acceso a un recurso ajeno (lo que RNF-07 cuenta como violacion)", async () => {
    await auditLogger.record({
      actor: INSTITUCION,
      actorType: "entidad",
      action: "documento.recibir",
      resource: `carpeta:${CIUDADANO}`,
      resourceOwner: CIUDADANO,
      outcome: "exito",
    });

    const entry = await AuditEntry.findOne({ action: "documento.recibir" }).lean();
    // Criterio de AuditQueryService.verifyNoOutOfPolicyAccess: exito + dueno distinto + no delegado = violacion.
    expect(entry.delegated).toBe(false);
    expect(entry.actor).not.toBe(entry.resourceOwner);
  });
});
