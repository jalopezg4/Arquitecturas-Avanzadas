/**
 * HU-05c, ola 2: ms-documentos del lado ORIGEN de una transferencia -- carpeta en solo lectura, exportacion de URLs y
 * metadatos, borrado al confirmarse y desbloqueo si falla.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const SecretsManager = require("../src/security/SecretsManager");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { DocumentService } = require("../src/application/DocumentService");
const { DocumentAuthenticationService } = require("../src/application/DocumentAuthenticationService");
const { TransferFolderService } = require("../src/application/TransferFolderService");
const { makeTransferHandlers } = require("../src/interfaces/eventHandlers");
const { pdf, makeFakeStorage, makeFakePublisher, validMeta } = require("./helpers");

const SECRET = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const ANA = "6aae9153b7655900026073f1";
const T1 = "6ab68fddb64d2aa730b41501";
const T2 = "6ab68fddb64d2aa730b41502";
const NOW = new Date("2026-09-26T15:00:00Z");
const secrets = new SecretsManager({ active: SECRET });
const token = () => secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: ANA, expiresIn: 900 });

let mongoServer;
let storage;
let publisher;
let handlers;
let app;
let folderRepository;
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
beforeEach(async () => {
  await Promise.all([Folder.createIndexes(), Document.createIndexes()]);
  storage = makeFakeStorage();
  publisher = makeFakePublisher();
  folderRepository = new FolderRepository();
  documentRepository = new DocumentRepository();
  const documentService = new DocumentService({ documentRepository, folderRepository, storage, eventPublisher: publisher, quota: 5, maxUploadBytes: 1024 * 1024, downloadTtlSeconds: 3600, eventPublishTimeoutMs: 200 });
  const documentAuthenticationService = new DocumentAuthenticationService({ documentRepository, folderRepository, eventPublisher: publisher, eventPublishTimeoutMs: 200 });
  const transferFolderService = new TransferFolderService({ folderRepository, documentRepository, storage, eventPublisher: publisher, urlTtlSeconds: 3600, eventPublishTimeoutMs: 200, now: () => NOW });
  handlers = makeTransferHandlers({ transferFolderService });
  app = buildApp({ documentService, documentAuthenticationService, secrets, issuer: "ms-identidad", maxUploadBytes: 1024 * 1024 });
});

const upload = () =>
  request(app)
    .post(`/api/v1/citizens/${ANA}/documents`)
    .set("Authorization", `Bearer ${token()}`)
    .field("titulo", validMeta.titulo)
    .field("entidadAvaladora", validMeta.entidadAvaladora)
    .field("fecha", validMeta.fecha)
    .attach("archivo", pdf(), { filename: "d.pdf", contentType: "application/pdf" });
const exportado = () => publisher.publish.mock.calls.filter(([rk]) => rk === "transferencia.carpeta_exportada").map(([, p]) => p);

describe("transferencia.exportar_carpeta", () => {
  test("bloquea la carpeta y responde con una URL prefirmada y los metadatos de cada documento", async () => {
    await upload().expect(201);
    await upload().expect(201);
    await Folder.updateOne({ ciudadanoId: ANA }, { documento: 1000000001 });

    await handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA });

    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).transferenciaId).toBe(T1);
    const [reply] = exportado();
    expect(reply).toMatchObject({ transferenciaId: T1, ciudadanoId: ANA, ok: true, urlsVencenEn: "2026-09-26T16:00:00.000Z" });
    expect(reply.documentos).toHaveLength(2);
    expect(reply.documentos[0]).toMatchObject({ titulo: validMeta.titulo, entidadAvaladora: validMeta.entidadAvaladora, estado: "temporal", mimeType: "application/pdf" });
    expect(reply.documentos[0].url).toMatch(/^http:\/\/storage\.test\/ciudadanos\/.+expires=3600$/);
    expect(reply.documentos[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("un documento 'en autenticacion' viaja como temporal (GovCarpeta aun no lo certifico)", async () => {
    await upload().expect(201);
    await Document.updateMany({}, { estado: "en autenticacion" });

    await handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA });

    expect(exportado()[0].documentos[0].estado).toBe("temporal");
  });

  test("un ciudadano sin documentos (ni carpeta) tambien se exporta: lista vacia y carpeta creada bloqueada", async () => {
    await handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA });

    expect(exportado()[0]).toMatchObject({ ok: true, documentos: [] });
    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).transferenciaId).toBe(T1);
  });

  test("repetir la orden de la misma transferencia es idempotente; otra transferencia no puede tomar la carpeta", async () => {
    await handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA });
    await handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA });
    await handlers.exportar({ transferenciaId: T2, ciudadanoId: ANA });

    const replies = exportado();
    expect(replies.map((r) => r.ok)).toEqual([true, true, false]);
    expect(replies[2]).toMatchObject({ transferenciaId: T2, motivo: "carpeta_en_otra_transferencia" });
    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).transferenciaId).toBe(T1);
  });

  test("si el broker no confirma la respuesta, la orden falla para reintentarse", async () => {
    publisher.publish.mockRejectedValueOnce(new Error("broker caido"));
    await expect(handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA })).rejects.toThrow("broker caido");
  });

  test("ordenes mal formadas van a la cola de fallidos", async () => {
    await expect(handlers.exportar({ transferenciaId: "../x", ciudadanoId: ANA })).rejects.toBeInstanceOf(PermanentError);
    await expect(handlers.transferido({ transferenciaId: T1 })).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("carpeta en solo lectura (en transferencia)", () => {
  beforeEach(async () => {
    await upload().expect(201);
    await handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA });
  });

  test("el ciudadano no puede cargar documentos: 409 y no se sube nada", async () => {
    const puts = storage.put.mock.calls.length;

    const res = await upload().expect(409);

    expect(res.body.error).toMatch(/transferencia/);
    expect(storage.put.mock.calls.length).toBe(puts);
    expect(await Document.countDocuments()).toBe(1);
  });

  test("tampoco una entidad emisora (certificado, que no reserva cupo)", async () => {
    const documentService = new DocumentService({ documentRepository, folderRepository, storage, eventPublisher: publisher, quota: 5, maxUploadBytes: 1024 });
    await expect(documentService.upload({ ciudadanoId: ANA, file: { buffer: pdf(), mimetype: "application/pdf" }, metadata: validMeta, estado: "certificado" })).rejects.toThrow(/transferencia/);
  });

  test("no se puede pedir autenticar un documento: 409", async () => {
    await Folder.updateOne({ ciudadanoId: ANA }, { documento: 1000000001 });
    const doc = await Document.findOne().lean();

    await request(app).put(`/api/v1/documents/${doc._id}/authenticate`).set("Authorization", `Bearer ${token()}`).expect(409);
  });

  test("la consulta sigue funcionando (solo lectura, no fuera de servicio)", async () => {
    const res = await request(app).get(`/api/v1/citizens/${ANA}/documents`).set("Authorization", `Bearer ${token()}`).expect(200);
    expect(res.body.total).toBe(1);
  });
});

describe("ciudadano.transferido / transferencia.cancelada", () => {
  test("al confirmarse: borra los objetos del storage, los documentos y la carpeta; repetirlo no hace nada", async () => {
    await upload().expect(201);
    await upload().expect(201);
    await handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA });

    await handlers.transferido({ transferenciaId: T1, ciudadanoId: ANA });
    await handlers.transferido({ transferenciaId: T1, ciudadanoId: ANA });

    expect(storage.objects.size).toBe(0);
    expect(await Document.countDocuments({ ciudadanoId: ANA })).toBe(0);
    expect(await Folder.countDocuments({ ciudadanoId: ANA })).toBe(0);
  });

  test("si el storage falla, NO borra los metadatos (el reintento termina el trabajo)", async () => {
    await upload().expect(201);
    await handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA });
    storage.delete.mockRejectedValueOnce(new Error("storage caido"));

    await expect(handlers.transferido({ transferenciaId: T1, ciudadanoId: ANA })).rejects.toThrow("storage caido");
    expect(await Document.countDocuments({ ciudadanoId: ANA })).toBe(1);

    await handlers.transferido({ transferenciaId: T1, ciudadanoId: ANA });
    expect(await Document.countDocuments({ ciudadanoId: ANA })).toBe(0);
  });

  test("un ciudadano.transferido de OTRA transferencia no borra nada", async () => {
    await upload().expect(201);
    await handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA });

    await expect(handlers.transferido({ transferenciaId: T2, ciudadanoId: ANA })).resolves.toBeUndefined();

    expect(await Document.countDocuments({ ciudadanoId: ANA })).toBe(1);
  });

  test("cancelada desbloquea la carpeta y el ciudadano vuelve a cargar; otra transferencia no la desbloquea", async () => {
    await upload().expect(201);
    await handlers.exportar({ transferenciaId: T1, ciudadanoId: ANA });

    await handlers.cancelada({ transferenciaId: T2, ciudadanoId: ANA });
    await upload().expect(409);

    await handlers.cancelada({ transferenciaId: T1, ciudadanoId: ANA });
    await upload().expect(201);
  });
});
