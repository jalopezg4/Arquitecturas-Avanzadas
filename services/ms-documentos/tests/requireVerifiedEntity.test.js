/**
 * ADR-07: capa de autorizacion institucional en ms-documentos, preparada para HU-10.
 *
 *     requireEntityAuth      -> ¿eres una entidad?          401 si no
 *     requireVerifiedEntity  -> ¿estas VERIFICADA?          403 si no
 *
 * HU-10 todavia no esta implementada: aqui se monta una ruta de prueba con esa misma cadena para comprobar que la
 * capa funciona y que la bitacora registra lo que HU-10 va a necesitar.
 */
const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const SecretsManager = require("../src/security/SecretsManager");
const requireAuth = require("../src/security/requireAuth");
const requireEntityAuth = require("../src/security/requireEntityAuth");
const requireVerifiedEntity = require("../src/security/requireVerifiedEntity");
const AuditEntry = require("../src/domain/AuditEntry");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const logger = require("../src/tracing/logger");

const CITIZEN_SECRET = "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAu";
const ENTITY_SECRET = "Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A";
const citizenSecrets = new SecretsManager({ active: CITIZEN_SECRET });
const entitySecrets = new SecretsManager({ active: ENTITY_SECRET });

const CIUDADANO = "665f1c04c9de9c4c34f6b52a";
const INSTITUCION = "6aae9153b7655900026073f1";

/** Token institucional tal como lo emite ms-comparticion: `ver` refleja el estado de verificacion al emitirlo. */
const entityToken = ({ ver = false, ...claims } = {}, options = {}) =>
  entitySecrets.sign({ typ: "access", act: "entidad", ver, ...claims }, { issuer: "ms-comparticion", subject: INSTITUCION, expiresIn: 900, ...options });
const citizenToken = (claims = {}, options = {}) =>
  citizenSecrets.sign({ typ: "access", ...claims }, { issuer: "ms-identidad", subject: CIUDADANO, expiresIn: 900, ...options });

let mongoServer;
let auditLogger;
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
  await AuditEntry.createIndexes();
  auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });

  app = express();
  // La forma de la ruta la definira HU-10; lo que importa aqui es el ORDEN de la cadena.
  app.post(
    "/api/v1/citizens/:id/documents/inbound",
    requireEntityAuth(entitySecrets),
    requireVerifiedEntity(auditLogger, "documento.recibir"),
    (req, res) => res.status(201).json({ institutionId: req.auth.institutionId, verificada: req.auth.verificada, ciudadanoId: req.params.id })
  );
});

const pedir = (token) => {
  const r = request(app).post(`/api/v1/citizens/${CIUDADANO}/documents/inbound`);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};

describe("requireVerifiedEntity: solo pasa una entidad VERIFICADA", () => {
  test("entidad verificada (ver:true) -> pasa, y llega con su institutionId", async () => {
    const res = await pedir(entityToken({ ver: true })).expect(201);

    expect(res.body).toMatchObject({ institutionId: INSTITUCION, verificada: true, ciudadanoId: CIUDADANO });
  });

  test("entidad NO verificada -> 403, no 401: la credencial es valida, falta autorizacion", async () => {
    const res = await pedir(entityToken({ ver: false }));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "la entidad no esta verificada por el operador" });
  });

  test("un token SIN el claim `ver` se trata como no verificada (falla cerrado)", async () => {
    const sinClaim = entitySecrets.sign({ typ: "access", act: "entidad" }, { issuer: "ms-comparticion", subject: INSTITUCION, expiresIn: 900 });

    await pedir(sinClaim).expect(403);
  });

  test.each([
    ["la cadena 'true'", "true"],
    ["el numero 1", 1],
    ["null", null],
  ])("un `ver` que no es el booleano true (%s) no autoriza", async (_name, ver) => {
    await pedir(entityToken({ ver })).expect(403);
  });

  test("un token de CIUDADANO se rechaza antes, con 401 (nunca llega a la verificacion)", async () => {
    for (const token of [citizenToken(), citizenToken({ act: "entidad", ver: true })]) {
      const res = await pedir(token);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "token invalido o expirado" });
    }
  });

  test("un token institucional invalido es 401, no 403", async () => {
    const imitador = citizenSecrets.sign({ typ: "access", act: "entidad", ver: true }, { issuer: "ms-comparticion", subject: INSTITUCION, expiresIn: 900 });
    const invalidos = [undefined, entityToken({ ver: true }, { expiresIn: -10 }), entityToken({ ver: true }, { issuer: "ms-identidad" }), imitador];

    for (const token of invalidos) await pedir(token).expect(401);
  });

  test("si la ruta se monta SIN requireEntityAuth delante, responde 403 y no deja pasar", async () => {
    const mal = express();
    mal.post("/suelta", requireVerifiedEntity(auditLogger), (_req, res) => res.status(201).json({ ok: true }));

    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));

    await request(mal).post("/suelta").expect(403);
    expect(lines.join("\n")).toContain("autorizacion.middleware_mal_montado");
  });
});

describe("Bitacora del rechazo y de lo que HU-10 registrara", () => {
  test("el rechazo por no verificada queda auditado con la entidad como actor y el ciudadano como dueno", async () => {
    await pedir(entityToken({ ver: false })).expect(403);

    const entry = await AuditEntry.findOne({ action: "documento.recibir" }).lean();
    expect(entry).toMatchObject({
      actor: INSTITUCION,
      actorType: "entidad",
      resource: `carpeta:${CIUDADANO}`,
      resourceOwner: CIUDADANO,
      outcome: "rechazo",
      reason: "entidad_no_verificada",
    });
    // Un rechazo NO es una violacion de RNF-07: es la prueba de que la politica funciono.
    expect(entry.delegated).toBe(false);
  });

  test("una entidad verificada no genera entrada de rechazo", async () => {
    await pedir(entityToken({ ver: true })).expect(201);

    expect(await AuditEntry.countDocuments({ outcome: "rechazo" })).toBe(0);
  });

  test("si la bitacora falla, el rechazo SIGUE siendo un rechazo (no se convierte en permiso)", async () => {
    const roto = express();
    roto.post(
      "/api/v1/citizens/:id/documents/inbound",
      requireEntityAuth(entitySecrets),
      requireVerifiedEntity({ record: async () => { throw new Error("mongo caido"); } }, "documento.recibir"),
      (_req, res) => res.status(201).json({ ok: true })
    );

    const res = await request(roto).post(`/api/v1/citizens/${CIUDADANO}/documents/inbound`).set("Authorization", `Bearer ${entityToken({ ver: false })}`);

    expect(res.status).toBe(403);
  });

  test("HU-10 podra registrar la entrega como accion DELEGADA de la entidad sobre la carpeta del ciudadano", async () => {
    // Esto es lo que HU-10 escribira tras una entrega aceptada; sin `delegated:true`,
    // AuditQueryService.verifyNoOutOfPolicyAccess() lo contaria como violacion de RNF-07.
    await auditLogger.record({
      actor: INSTITUCION,
      actorType: "entidad",
      action: "documento.recibir",
      resource: `carpeta:${CIUDADANO}`,
      resourceOwner: CIUDADANO,
      delegated: true,
      outcome: "exito",
    });

    const entry = await AuditEntry.findOne({ outcome: "exito" }).lean();
    expect(entry).toMatchObject({ actorType: "entidad", delegated: true, resourceOwner: CIUDADANO });
    expect(entry.actor).not.toBe(entry.resourceOwner);
  });
});
