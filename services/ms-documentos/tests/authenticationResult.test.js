/**
 * HU-04, ola 5: ms-documentos aplica el resultado que publica ms-autenticacion. `documento.autenticado` -> certificado
 * con fecha y cupo liberado; `documento.autenticacion_fallida` -> vuelve a temporal. Ambos idempotentes.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { DocumentAuthenticationService } = require("../src/application/DocumentAuthenticationService");
const { makeAuthenticationResultHandlers } = require("../src/interfaces/eventHandlers");
const { makeFakePublisher } = require("./helpers");

const ANA = "6aae9153b7655900026073f1";
const NOW = new Date("2026-09-26T15:00:00Z");
const AUTENTICADO_EN = "2026-09-26T15:00:30.000Z";

let mongoServer;
let service;
let handlers;
let documentRepository;

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
  documentRepository = new DocumentRepository();
  service = new DocumentAuthenticationService({ documentRepository, folderRepository: new FolderRepository(), eventPublisher: makeFakePublisher(), now: () => NOW });
  handlers = makeAuthenticationResultHandlers({ documentAuthenticationService: service });
});

/** Documento temporal de Ana (con su cupo ocupado) ya pedido a autenticar: queda `en autenticacion`, intento 1. */
async function enAutenticacion() {
  const doc = await Document.create({
    ciudadanoId: ANA,
    titulo: "Diploma",
    entidadAvaladora: "EAFIT",
    fecha: new Date("2026-03-15"),
    storageKey: `ciudadanos/${ANA}/x.pdf`,
    mimeType: "application/pdf",
    tamanoBytes: 100,
    sha256: "a".repeat(64),
  });
  await Folder.create({ ciudadanoId: ANA, documento: 1000000001, noCertificados: 1, cupos: [String(doc._id)] });
  await documentRepository.startAuthentication(doc._id, ANA, NOW);
  return String(doc._id);
}
const cupo = async () => (await Folder.findOne({ ciudadanoId: ANA }).lean()).noCertificados;
const estado = async (id) => Document.findById(id).lean();

describe("documento.autenticado", () => {
  test("marca certificado con la fecha de autenticacion y libera el cupo del no certificado (RNF-04)", async () => {
    const id = await enAutenticacion();

    await handlers.autenticado({ eventId: `${id}-auth-1-ok`, documentoId: id, ciudadanoId: ANA, intento: 1, autenticadoEn: AUTENTICADO_EN });

    expect(await estado(id)).toMatchObject({ estado: "certificado", fechaAutenticacion: new Date(AUTENTICADO_EN) });
    expect(await cupo()).toBe(0);
  });

  test("una reentrega del mismo evento no libera el cupo dos veces", async () => {
    const id = await enAutenticacion();
    await Folder.updateOne({ ciudadanoId: ANA }, { noCertificados: 3, $push: { cupos: { $each: ["otro-1", "otro-2"] } } }); // otros temporales ocupan cupo

    const evento = { documentoId: id, intento: 1, autenticadoEn: AUTENTICADO_EN };
    await handlers.autenticado(evento);
    await handlers.autenticado(evento);
    await Promise.all([handlers.autenticado(evento), handlers.autenticado(evento)]);

    expect(await cupo()).toBe(2);
  });

  // Revision del PR #90: si liberar el cupo falla DESPUES de certificar, la reentrega lo libera (y solo una vez).
  test("si liberar el cupo falla tras certificar, la reentrega del evento lo libera", async () => {
    const id = await enAutenticacion();
    const folders = new FolderRepository();
    const real = folders.releaseNonCertified.bind(folders);
    let fallas = 1;
    folders.releaseNonCertified = async (...args) => {
      if (fallas-- > 0) throw new Error("mongo no disponible");
      return real(...args);
    };
    const h = makeAuthenticationResultHandlers({ documentAuthenticationService: new DocumentAuthenticationService({ documentRepository, folderRepository: folders, eventPublisher: makeFakePublisher(), now: () => NOW }) });
    const evento = { documentoId: id, intento: 1, autenticadoEn: AUTENTICADO_EN };

    await expect(h.autenticado(evento)).rejects.toThrow("mongo no disponible");
    expect((await estado(id)).estado).toBe("certificado");
    expect(await cupo()).toBe(1);

    await h.autenticado(evento); // reentrega
    await h.autenticado(evento);
    expect(await cupo()).toBe(0);
  });

  test("un resultado de un intento viejo no certifica el intento vigente", async () => {
    const id = await enAutenticacion();
    await handlers.autenticacionFallida({ documentoId: id, intento: 1, motivo: "no_disponible" });
    await documentRepository.startAuthentication(id, ANA, NOW); // intento 2

    await handlers.autenticado({ documentoId: id, intento: 1, autenticadoEn: AUTENTICADO_EN });

    expect((await estado(id)).estado).toBe("en autenticacion");
  });

  test("sin fecha valida usa la hora de recepcion", async () => {
    const id = await enAutenticacion();
    await handlers.autenticado({ documentoId: id, intento: 1, autenticadoEn: "ayer" });
    expect((await estado(id)).fechaAutenticacion).toEqual(NOW);
  });
});

describe("documento.autenticacion_fallida", () => {
  test("vuelve a temporal (no queda colgado) y conserva su cupo", async () => {
    const id = await enAutenticacion();

    await handlers.autenticacionFallida({ documentoId: id, intento: 1, motivo: "rechazado" });

    expect(await estado(id)).toMatchObject({ estado: "temporal", fechaAutenticacion: null });
    expect(await cupo()).toBe(1);
  });

  test("despues de fallar se puede volver a pedir (nuevo intento)", async () => {
    const id = await enAutenticacion();
    await handlers.autenticacionFallida({ documentoId: id, intento: 1 });

    expect(await documentRepository.startAuthentication(id, ANA, NOW)).toMatchObject({ autenticacionIntento: 2 });
  });
});

describe("Mensajes invalidos van a la cola de fallidos", () => {
  test.each([
    ["no es objeto", null],
    ["documentoId invalido", { documentoId: "../x", intento: 1 }],
    ["intento invalido", { documentoId: "6ab68fddb64d2aa730b415bb", intento: "1" }],
  ])("%s", async (_caso, payload) => {
    await expect(handlers.autenticado(payload)).rejects.toBeInstanceOf(PermanentError);
    await expect(handlers.autenticacionFallida(payload)).rejects.toBeInstanceOf(PermanentError);
  });

  test("un documento inexistente no es un error: se ignora (no hay nada que reintentar)", async () => {
    await expect(handlers.autenticado({ documentoId: "6ab68fddb64d2aa730b415bb", intento: 1 })).resolves.toBeUndefined();
  });
});
