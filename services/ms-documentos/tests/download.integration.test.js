/**
 * HU-09 (RF-23): descarga de un documento propio con URL prefirmada de 1 hora. Nombres alineados con el issue #62.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const AuditEntry = require("../src/domain/AuditEntry");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const ObjectStorageAdapter = require("../src/infrastructure/ObjectStorageAdapter");
const SecretsManager = require("../src/security/SecretsManager");
const { DocumentService } = require("../src/application/DocumentService");
const { makeFakeStorage, makeFakePublisher } = require("./helpers");

const ANA = "6aae9153b7655900026073f1";
const BETO = "6aae9153b7655900026073f2";
const NOW = new Date("2026-09-26T15:00:00Z");
const secrets = new SecretsManager({ active: "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe" });
const tokenFor = (sub) => secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: sub, expiresIn: 900 });

let mongoServer;
let storage;
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

function build(storageImpl) {
  storage = storageImpl || makeFakeStorage();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const documentService = new DocumentService({ documentRepository: new DocumentRepository(), folderRepository: new FolderRepository(), storage, eventPublisher: makeFakePublisher(), auditLogger, quota: 5, maxUploadBytes: 1024, downloadTtlSeconds: 3600, now: () => NOW });
  app = buildApp({ documentService, secrets, issuer: "ms-identidad", auditLogger, maxUploadBytes: 1024 });
}
beforeEach(() => build());

const documentoDe = (ciudadanoId, extra = {}) =>
  Document.create({ ciudadanoId, titulo: "Diploma", entidadAvaladora: "EAFIT", fecha: new Date("2026-03-15"), storageKey: `ciudadanos/${ciudadanoId}/1.pdf`, mimeType: "application/pdf", tamanoBytes: 10, sha256: "a".repeat(64), ...extra });
const descargar = (id, token = tokenFor(ANA)) => {
  const req = request(app).get(`/api/v1/documents/${id}/download`);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
};

describe("Escenario: descarga exitosa", () => {
  test("200 {downloadUrl} con URL prefirmada de 1 hora y Cache-Control: no-store", async () => {
    const doc = await documentoDe(ANA);

    const res = await descargar(doc._id).expect(200);

    expect(res.body).toEqual({ documentoId: String(doc._id), titulo: "Diploma", mimeType: "application/pdf", downloadUrl: `http://storage.test/ciudadanos/${ANA}/1.pdf?expires=3600`, expiraEn: "2026-09-26T16:00:00.000Z" });
    expect(storage.presignedGetUrl).toHaveBeenCalledWith(`ciudadanos/${ANA}/1.pdf`, 3600);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("DocumentService.download() genera URL prefirmada de 1 hora con el adaptador real (X-Amz-Expires=3600)", async () => {
    build(ObjectStorageAdapter.fromConfig({ endpoint: "http://minio:9000", publicEndpoint: "http://localhost:9000", region: "us-east-1", bucket: "carpeta-documentos", accessKeyId: "AKIATEST", secretAccessKey: "test-secret-not-real", forcePathStyle: true })); // secret-scan:allow
    const doc = await documentoDe(ANA);

    const res = await descargar(doc._id).expect(200);

    expect(new URL(res.body.downloadUrl).searchParams.get("X-Amz-Expires")).toBe("3600");
  });

  test("se registra la descarga en la bitacora (RF-39 / RNF-07): ciudadano, documento y fecha", async () => {
    const doc = await documentoDe(ANA);
    await descargar(doc._id).expect(200);

    const entry = await AuditEntry.findOne({ action: "documento.descargar" }).lean();
    expect(entry).toMatchObject({ actor: ANA, actorType: "ciudadano", resource: `documento:${doc._id}`, resourceOwner: ANA, outcome: "exito" });
    expect(entry.createdAt || entry.timestamp).toBeTruthy();
  });

  test("funciona aunque la carpeta este en transferencia (es solo lectura)", async () => {
    await Folder.create({ ciudadanoId: ANA, transferenciaId: "6ab68fddb64d2aa730b41501" });
    const doc = await documentoDe(ANA);
    await descargar(doc._id).expect(200);
  });
});

describe("Escenario: documento no existe", () => {
  test.each([["665f1c04c9de9c4c34f6b599"], ["no-es-un-id"]])("404 (%s) y no se firma nada", async (id) => {
    await descargar(id).expect(404);
    expect(storage.presignedGetUrl).not.toHaveBeenCalled();
  });
});

describe("Escenario: intento de descargar documento ajeno", () => {
  test("403, no se firma ninguna URL y el intento queda en la bitacora como no_es_dueno", async () => {
    const doc = await documentoDe(BETO);

    const res = await descargar(doc._id).expect(403);

    expect(res.body).not.toHaveProperty("downloadUrl");
    expect(storage.presignedGetUrl).not.toHaveBeenCalled();
    expect(await AuditEntry.findOne({ action: "documento.descargar" }).lean()).toMatchObject({ actor: ANA, resourceOwner: BETO, outcome: "rechazo", reason: "no_es_dueno" });
  });

  test("401 sin token", async () => {
    const doc = await documentoDe(ANA);
    await descargar(doc._id, null).expect(401);
  });
});
