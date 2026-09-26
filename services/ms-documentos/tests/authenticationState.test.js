/**
 * HU-04, ola 1: transiciones de estado de la autenticacion en DocumentRepository. Todas son escrituras condicionales:
 * dos solicitudes simultaneas, un resultado repetido o un resultado de un intento viejo nunca aplican dos veces.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Document = require("../src/domain/Document");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");

const ANA = "665f1c04c9de9c4c34f6b52a";
const BETO = "665f1c04c9de9c4c34f6b52b";
const AHORA = new Date("2026-09-26T15:00:00Z");

let mongoServer;
let repo;

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
  await Document.createIndexes();
  repo = new DocumentRepository();
});

let n = 0;
function crearDocumento(extra = {}) {
  n += 1;
  return Document.create({
    ciudadanoId: ANA,
    titulo: "Diploma",
    entidadAvaladora: "EAFIT",
    fecha: new Date("2026-03-15"),
    storageKey: `ciudadanos/${ANA}/doc-${n}.pdf`,
    mimeType: "application/pdf",
    tamanoBytes: 100,
    sha256: "a".repeat(64),
    ...extra,
  });
}

describe("Document: estado 'en autenticacion'", () => {
  test("es un estado valido del modelo, pero no un estado con el que se pueda cargar", () => {
    expect(Document.ESTADOS).toContain("en autenticacion");
    expect(Document.ESTADOS_DE_CARGA).toEqual(["temporal", "certificado"]);
  });

  test("un documento nuevo no tiene autenticacion pendiente", async () => {
    const doc = await crearDocumento();
    expect(doc.toObject()).toMatchObject({ autenticacionIntento: 0, autenticacionEventoPublicado: true, fechaAutenticacion: null });
  });
});

describe("DocumentRepository.startAuthentication()", () => {
  test("pasa de temporal a 'en autenticacion', abre un intento nuevo y deja el evento pendiente", async () => {
    const doc = await crearDocumento();

    const actualizado = await repo.startAuthentication(doc._id, ANA, AHORA);

    expect(actualizado).toMatchObject({ estado: "en autenticacion", autenticacionIntento: 1, autenticacionEventoPublicado: false });
    expect(actualizado.autenticacionSolicitadaEn).toEqual(AHORA);
  });

  test("no toca un documento de otro ciudadano (devuelve null)", async () => {
    const doc = await crearDocumento();

    expect(await repo.startAuthentication(doc._id, BETO, AHORA)).toBeNull();
    expect((await Document.findById(doc._id).lean()).estado).toBe("temporal");
  });

  test.each([["certificado"], ["en autenticacion"]])("no toca un documento en estado %s", async (estado) => {
    const doc = await crearDocumento({ estado });
    expect(await repo.startAuthentication(doc._id, ANA, AHORA)).toBeNull();
  });

  test("8 solicitudes simultaneas: exactamente una gana", async () => {
    const doc = await crearDocumento();

    const resultados = await Promise.all(Array.from({ length: 8 }, () => repo.startAuthentication(doc._id, ANA, AHORA)));

    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect((await Document.findById(doc._id).lean()).autenticacionIntento).toBe(1);
  });
});

describe("DocumentRepository.completeAuthentication() / revertAuthentication()", () => {
  test("completar marca certificado con la fecha de autenticacion", async () => {
    const doc = await crearDocumento();
    await repo.startAuthentication(doc._id, ANA, AHORA);

    const fecha = new Date("2026-09-26T15:01:00Z");
    const certificado = await repo.completeAuthentication(doc._id, 1, fecha);

    expect(certificado).toMatchObject({ estado: "certificado", fechaAutenticacion: fecha });
  });

  test("un resultado repetido no aplica dos veces (el segundo devuelve null)", async () => {
    const doc = await crearDocumento();
    await repo.startAuthentication(doc._id, ANA, AHORA);

    expect(await repo.completeAuthentication(doc._id, 1, AHORA)).not.toBeNull();
    expect(await repo.completeAuthentication(doc._id, 1, AHORA)).toBeNull();
  });

  test("un resultado de un intento viejo no pisa el intento vigente", async () => {
    const doc = await crearDocumento();
    await repo.startAuthentication(doc._id, ANA, AHORA); // intento 1
    await repo.revertAuthentication(doc._id, 1); // fallo -> temporal
    await repo.startAuthentication(doc._id, ANA, AHORA); // intento 2

    expect(await repo.completeAuthentication(doc._id, 1, AHORA)).toBeNull();
    expect(await repo.revertAuthentication(doc._id, 1)).toBeNull();
    expect((await Document.findById(doc._id).lean()).estado).toBe("en autenticacion");
  });

  test("revertir devuelve el documento a temporal, y desde ahi se puede volver a pedir", async () => {
    const doc = await crearDocumento();
    await repo.startAuthentication(doc._id, ANA, AHORA);

    expect(await repo.revertAuthentication(doc._id, 1)).toMatchObject({ estado: "temporal" });
    expect(await repo.startAuthentication(doc._id, ANA, AHORA)).toMatchObject({ estado: "en autenticacion", autenticacionIntento: 2 });
  });
});

describe("Reconciliacion de solicitudes de autenticacion", () => {
  test("findUnpublishedAuthRequests solo trae las pendientes con la antiguedad minima", async () => {
    const viejo = await crearDocumento();
    const reciente = await crearDocumento();
    const publicado = await crearDocumento();
    await repo.startAuthentication(viejo._id, ANA, new Date("2026-09-26T14:00:00Z"));
    await repo.startAuthentication(reciente._id, ANA, new Date("2026-09-26T14:59:50Z"));
    await repo.startAuthentication(publicado._id, ANA, new Date("2026-09-26T14:00:00Z"));
    await repo.markAuthRequestPublished(publicado._id, 1);

    const pendientes = await repo.findUnpublishedAuthRequests({ olderThan: new Date("2026-09-26T14:59:00Z"), limit: 10 });

    expect(pendientes.map((d) => String(d._id))).toEqual([String(viejo._id)]);
  });

  test("markAuthRequestPublished no marca un intento posterior al que se publico", async () => {
    const doc = await crearDocumento();
    await repo.startAuthentication(doc._id, ANA, AHORA);
    await repo.revertAuthentication(doc._id, 1);
    await repo.startAuthentication(doc._id, ANA, AHORA); // intento 2, pendiente

    await repo.markAuthRequestPublished(doc._id, 1); // confirmacion tardia del intento 1

    expect((await Document.findById(doc._id).lean()).autenticacionEventoPublicado).toBe(false);
  });
});
