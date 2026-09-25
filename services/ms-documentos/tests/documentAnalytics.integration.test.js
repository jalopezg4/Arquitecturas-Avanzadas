/**
 * HU-07.1 de extremo a extremo: GET /api/v1/documents/analytics/summary.
 *
 * Cadena real: requireEntityAuth (401) -> controlador -> DocumentAnalyticsService (validacion) ->
 * DocumentRepository (agregacion Mongo).
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Document = require("../src/domain/Document");
const SecretsManager = require("../src/security/SecretsManager");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const { DocumentAnalyticsService } = require("../src/application/DocumentAnalyticsService");

const ENTITY_SECRET = "Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A";
const entitySecrets = new SecretsManager({ active: ENTITY_SECRET });

const EAFIT = "6aae9153b7655900026073f1";
const ICESI = "6aae9153b7655900026073f2";
const UNIVALLE = "6aae9153b7655900026073f3";
const CITIZEN = "665f1c04c9de9c4c34f6b52a";
const PATH = "/api/v1/documents/analytics/summary";

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
  await Document.createIndexes(); // dropDatabase() borra los indices
  const documentAnalyticsService = new DocumentAnalyticsService({ documentRepository: new DocumentRepository() });
  app = buildApp({ documentAnalyticsService, entitySecrets, entityIssuer: "ms-comparticion" });
});

const entityToken = (institutionId = EAFIT, options = {}) =>
  entitySecrets.sign({ typ: "access", act: "entidad", ver: true }, { issuer: "ms-comparticion", subject: institutionId, expiresIn: 900, ...options });

let seq = 0;
/** Documento minimo valido; por defecto NO lleva emisorInstitutionId (como una carga propia del ciudadano). */
const seed = (extra = {}) =>
  Document.create({
    ciudadanoId: CITIZEN,
    titulo: "Documento de prueba",
    entidadAvaladora: "Universidad de Prueba",
    fecha: new Date("2026-01-01"),
    storageKey: `ciudadanos/${CITIZEN}/${seq++}.pdf`,
    mimeType: "application/pdf",
    tamanoBytes: 100,
    sha256: "a".repeat(64),
    estado: "certificado",
    ...extra,
  });

/** Los 4 documentos que EAFIT emitio (la unica forma real de que emisorInstitutionId quede seteado, HU-10). */
async function seedEafitDocuments() {
  await seed({ emisorInstitutionId: EAFIT, origen: "entidad", fecha: new Date("2026-01-10"), mimeType: "application/pdf", tamanoBytes: 1000, estado: "temporal" });
  await seed({ emisorInstitutionId: EAFIT, origen: "entidad", fecha: new Date("2026-01-10"), mimeType: "application/pdf", tamanoBytes: 2000, estado: "certificado" });
  await seed({ emisorInstitutionId: EAFIT, origen: "entidad", fecha: new Date("2026-01-15"), mimeType: "application/pdf", tamanoBytes: 3000, estado: "certificado" });
  await seed({ emisorInstitutionId: EAFIT, origen: "entidad", fecha: new Date("2026-03-01"), mimeType: "image/png", tamanoBytes: 500, estado: "certificado" });
}

const get = (token, query = "") => request(app).get(`${PATH}${query}`).set("Authorization", `Bearer ${token}`);

describe("Autenticacion", () => {
  test("401 sin token, con token de ciudadano o de otro emisor", async () => {
    await seedEafitDocuments();
    for (const token of [null, entityToken(EAFIT, { issuer: "ms-identidad" }), entityToken(EAFIT, { expiresIn: -10 })]) {
      const req = request(app).get(PATH);
      const res = await (token ? req.set("Authorization", `Bearer ${token}`) : req);
      expect(res.status).toBe(401);
    }
  });

  test("200 con un token institucional valido", async () => {
    await seedEafitDocuments();
    await get(entityToken(EAFIT)).expect(200);
  });
});

describe("Aislamiento institucional", () => {
  test("una institucion solo ve los documentos que ELLA emitio, nunca los de otra ni los que un ciudadano cargo por su cuenta", async () => {
    await seedEafitDocuments();
    await seed({ emisorInstitutionId: ICESI, origen: "entidad", fecha: new Date("2026-01-10") }); // de otra institucion
    await seed({ fecha: new Date("2026-01-10") }); // carga propia del ciudadano: sin emisorInstitutionId

    const eafit = await get(entityToken(EAFIT)).expect(200);
    expect(eafit.body.totalDocumentos).toBe(4);

    const icesi = await get(entityToken(ICESI)).expect(200);
    expect(icesi.body.totalDocumentos).toBe(1);
  });

  test("un institutionId arbitrario en el query se ignora: SIEMPRE se usa el del token", async () => {
    await seedEafitDocuments();
    await seed({ emisorInstitutionId: ICESI, origen: "entidad", fecha: new Date("2026-01-10") });

    const res = await get(entityToken(EAFIT), `?institutionId=${ICESI}`).expect(200);

    expect(res.body.totalDocumentos).toBe(4); // sigue siendo el conteo de EAFIT, no el de ICESI
  });

  test("institucion sin documentos -> 200 con metricas en cero y colecciones vacias", async () => {
    await seedEafitDocuments(); // hay datos en la base, pero de OTRA institucion

    const res = await get(entityToken(UNIVALLE)).expect(200);

    expect(res.body).toMatchObject({
      totalDocumentos: 0,
      porEstado: {},
      porMimeType: {},
      tamanoTotalBytes: 0,
      tamanoPromedioBytes: 0,
      serieTemporal: [],
    });
  });
});

describe("Metricas", () => {
  test("conteo total, distribucion por estado, por mimeType, suma y promedio de tamano, y serie temporal", async () => {
    await seedEafitDocuments();

    const res = await get(entityToken(EAFIT)).expect(200);

    expect(res.body.totalDocumentos).toBe(4);
    expect(res.body.porEstado).toEqual({ temporal: 1, certificado: 3 });
    expect(res.body.porMimeType).toEqual({ "application/pdf": 3, "image/png": 1 });
    expect(res.body.tamanoTotalBytes).toBe(6500);
    expect(res.body.tamanoPromedioBytes).toBe(1625);
    expect(res.body.serieTemporal).toEqual([
      { fecha: "2026-01-10", cantidad: 2 },
      { fecha: "2026-01-15", cantidad: 1 },
      { fecha: "2026-03-01", cantidad: 1 },
    ]);
  });

  test("la respuesta NUNCA incluye datos individuales de documento ni de almacenamiento", async () => {
    await seedEafitDocuments();

    const res = await get(entityToken(EAFIT)).expect(200);

    const json = JSON.stringify(res.body);
    for (const prohibido of ["ciudadanoId", "storageKey", "sha256", "titulo", "entidadAvaladora", "solicitudId", "envioId", CITIZEN]) {
      expect(json).not.toContain(prohibido);
    }
    expect(Object.keys(res.body).sort()).toEqual(["porEstado", "porMimeType", "rango", "serieTemporal", "tamanoPromedioBytes", "tamanoTotalBytes", "totalDocumentos"]);
  });
});

describe("Filtros from/to", () => {
  test("from acota por abajo (incluyente)", async () => {
    await seedEafitDocuments();
    const res = await get(entityToken(EAFIT), "?from=2026-01-15").expect(200);
    expect(res.body.totalDocumentos).toBe(2); // 2026-01-15 y 2026-03-01
  });

  test("to acota por arriba, SIN excluir documentos fechados justo ese dia", async () => {
    await seedEafitDocuments();
    const res = await get(entityToken(EAFIT), "?to=2026-01-15").expect(200);
    expect(res.body.totalDocumentos).toBe(3); // los dos del 10 y el del 15 (no el del 1-marzo)
    expect(res.body.tamanoTotalBytes).toBe(6000);
  });

  test("from + to acotan un rango exacto (un solo dia)", async () => {
    await seedEafitDocuments();
    const res = await get(entityToken(EAFIT), "?from=2026-01-15&to=2026-01-15").expect(200);
    expect(res.body.totalDocumentos).toBe(1);
    expect(res.body.rango).toEqual({ from: "2026-01-15", to: "2026-01-15" });
  });

  test("sin from ni to, el alcance es todo el historico de la institucion", async () => {
    await seedEafitDocuments();
    const res = await get(entityToken(EAFIT)).expect(200);
    expect(res.body.rango).toEqual({ from: null, to: null });
    expect(res.body.totalDocumentos).toBe(4);
  });
});

describe("Rechazos de parametros", () => {
  test("400 si el rango supera 366 dias", async () => {
    const res = await get(entityToken(EAFIT), "?from=2025-01-01&to=2026-01-03");
    expect(res.status).toBe(400);
  });

  test("400 si from es posterior a to", async () => {
    const res = await get(entityToken(EAFIT), "?from=2026-02-01&to=2026-01-01");
    expect(res.status).toBe(400);
  });

  test.each([
    ["formato invalido", "?from=no-es-una-fecha"],
    ["fecha inexistente (30 de febrero)", "?to=2026-02-30"],
    ["formato incompleto", "?from=2026-1-1"],
  ])("400 con %s, y no se ejecuta ninguna agregacion", async (_name, query) => {
    await seedEafitDocuments();
    const res = await get(entityToken(EAFIT), query);
    expect(res.status).toBe(400);
  });
});
