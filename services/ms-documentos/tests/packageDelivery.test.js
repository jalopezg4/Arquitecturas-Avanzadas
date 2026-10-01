/**
 * HU-06.2, ola 2: ms-documentos entrega paquetes documentales -- comprueba que los documentos sean del ciudadano,
 * concede el acceso a la entidad (carpeta institucional) o prepara el correo con enlaces temporales, y deja que la
 * entidad descargue SOLO lo que se le entrego.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const PackageGrant = require("../src/domain/PackageGrant");
const AuditEntry = require("../src/domain/AuditEntry");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const SecretsManager = require("../src/security/SecretsManager");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { PackageDeliveryService } = require("../src/application/PackageDeliveryService");
const { makePackageCreatedHandler } = require("../src/interfaces/eventHandlers");
const { makeFakeStorage, makeFakePublisher } = require("./helpers");

const ANA = "6aae9153b7655900026073f1";
const BETO = "6aae9153b7655900026073f2";
const EAFIT = "6ab68fddb64d2aa730b415e1";
const OTRA = "6ab68fddb64d2aa730b415e2";
const P1 = "6ab68fddb64d2aa730b41601";
const NOW = new Date("2026-09-26T15:00:00Z");
const secrets = new SecretsManager({ active: "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe" });
const entitySecrets = new SecretsManager({ active: "Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A" });
const entityToken = (sub, ver = true) => entitySecrets.sign({ typ: "access", act: "entidad", ver }, { issuer: "ms-comparticion", subject: sub, expiresIn: 900 });

let mongoServer;
let storage;
let publisher;
let service;
let handler;
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
  await PackageGrant.createIndexes();
  storage = makeFakeStorage();
  publisher = makeFakePublisher();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  service = new PackageDeliveryService({ documentRepository: new DocumentRepository(), folderRepository: new FolderRepository(), storage, eventPublisher: publisher, auditLogger, emailUrlTtlSeconds: 3600, entityUrlTtlSeconds: 900, eventPublishTimeoutMs: 200, now: () => NOW });
  handler = makePackageCreatedHandler({ packageDeliveryService: service });
  app = buildApp({ documentService: {}, packageDeliveryService: service, secrets, entitySecrets, issuer: "ms-identidad", entityIssuer: "ms-comparticion", auditLogger, maxUploadBytes: 1024 });
  await Folder.create({ ciudadanoId: ANA, direccionUnica: "1000000001-ab12cd34@carpetacolombia.co" });
});

let n = 0;
const documentoDe = async (ciudadanoId, titulo = "Diploma") => {
  n += 1;
  return String((await Document.create({ ciudadanoId, titulo, entidadAvaladora: "EAFIT", fecha: new Date("2026-03-15"), storageKey: `ciudadanos/${ciudadanoId}/${n}.pdf`, mimeType: "application/pdf", tamanoBytes: 10, sha256: "a".repeat(64), estado: "certificado" }))._id);
};
const published = (rk) => publisher.publish.mock.calls.filter(([k]) => k === rk).map(([, p]) => p);
const aCarpeta = (documentoIds) => ({ paqueteId: P1, ciudadanoId: ANA, documentoIds, canal: "carpeta_institucional", institutionId: EAFIT });
const porCorreo = (documentoIds) => ({ paqueteId: P1, ciudadanoId: ANA, documentoIds, canal: "correo", correoDestino: "rrhh@empresa.co", nombreDestino: "Empresa X" });
const descargar = (docId, token = entityToken(EAFIT), paquete = P1) => request(app).get(`/api/v1/packages/${paquete}/documents/${docId}/download`).set("Authorization", `Bearer ${token}`);

describe("PackageService/PackageDeliveryService: el paquete referencia documentos existentes sin duplicarlos", () => {
  test("carpeta institucional: registra el permiso (referencias) y responde con metadatos y remitente", async () => {
    const d1 = await documentoDe(ANA, "Diploma");
    const d2 = await documentoDe(ANA, "Acta");

    await handler(aCarpeta([d1, d2]));

    expect(await PackageGrant.findOne({ paqueteId: P1 }).lean()).toMatchObject({ institutionId: EAFIT, ciudadanoId: ANA, documentoIds: [d1, d2] });
    expect(storage.put).not.toHaveBeenCalled(); // nada se copia
    const [resp] = published("paquete.procesado");
    expect(resp).toMatchObject({ paqueteId: P1, ok: true, remitenteDireccionUnica: "1000000001-ab12cd34@carpetacolombia.co" });
    expect(resp.documentos.map((d) => d.titulo)).toEqual(["Diploma", "Acta"]);
    expect(JSON.stringify(resp)).not.toMatch(/ciudadanos\/|storage\.test/); // sin claves ni URLs
  });

  test("correo: firma una URL temporal por documento y pide el envio a ms-notificaciones (RF-26)", async () => {
    const d1 = await documentoDe(ANA, "Diploma");

    await handler(porCorreo([d1]));

    const [envio] = published("paquete.envio_correo");
    expect(envio).toMatchObject({ eventId: P1, paqueteId: P1, ciudadanoId: ANA, correo: "rrhh@empresa.co", nombreDestino: "Empresa X", vencenEn: "2026-09-26T16:00:00.000Z" });
    expect(envio.documentos).toEqual([{ titulo: "Diploma", url: expect.stringMatching(/expires=3600$/) }]);
    expect(await PackageGrant.countDocuments()).toBe(0);
    expect(published("paquete.procesado")[0]).toMatchObject({ ok: true });
  });

  test("un documento de OTRO ciudadano (o inexistente) rechaza el paquete entero, sin conceder ni enviar nada", async () => {
    const mio = await documentoDe(ANA);
    const ajeno = await documentoDe(BETO);

    await handler(aCarpeta([mio, ajeno]));
    await handler({ ...porCorreo([mio, "6ab68fddb64d2aa730b415ff"]), paqueteId: "6ab68fddb64d2aa730b41602" });

    expect(await PackageGrant.countDocuments()).toBe(0);
    expect(published("paquete.envio_correo")).toHaveLength(0);
    expect(published("paquete.procesado").map((p) => p.ok)).toEqual([false, false]);
    expect(await AuditEntry.findOne({ action: "documento.compartir", outcome: "rechazo" }).lean()).toMatchObject({ reason: "documento_no_es_del_ciudadano" });
  });

  test("una reentrega de la orden no crea otro permiso", async () => {
    const d1 = await documentoDe(ANA);
    await handler(aCarpeta([d1]));
    await handler(aCarpeta([d1]));
    expect(await PackageGrant.countDocuments()).toBe(1);
  });

  test.each([
    ["canal desconocido", { canal: "fax" }],
    ["correo con varios destinatarios", { canal: "correo", correoDestino: "a@b.co,c@d.co" }],
    ["sin institucion en canal carpeta", { canal: "carpeta_institucional", institutionId: undefined }],
    ["ids invalidos", { documentoIds: ["../x"] }],
  ])("orden mal formada (%s) -> cola de fallidos", async (_caso, extra) => {
    await expect(handler({ ...aCarpeta(["6ab68fddb64d2aa730b415b1"]), ...extra })).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("GET /api/v1/packages/:paqueteId/documents/:documentoId/download (la entidad)", () => {
  test("la entidad del paquete descarga un documento incluido: URL de 15 minutos, no-store y bitacora delegada", async () => {
    const d1 = await documentoDe(ANA);
    await handler(aCarpeta([d1]));

    const res = await descargar(d1).expect(200);

    expect(res.body).toMatchObject({ documentoId: d1, titulo: "Diploma", expiraEn: "2026-09-26T15:15:00.000Z" });
    expect(res.body.downloadUrl).toMatch(/expires=900$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(await AuditEntry.findOne({ action: "documento.descargar" }).lean()).toMatchObject({ actor: EAFIT, actorType: "entidad", resourceOwner: ANA, delegated: true, outcome: "exito" });
  });

  test("otra entidad, un documento fuera del paquete o un paquete inexistente -> 404 (no se revela nada)", async () => {
    const d1 = await documentoDe(ANA);
    const fuera = await documentoDe(ANA, "Otro");
    await handler(aCarpeta([d1]));

    await descargar(d1, entityToken(OTRA)).expect(404);
    await descargar(fuera).expect(404);
    await descargar(d1, entityToken(EAFIT), "6ab68fddb64d2aa730b41699").expect(404);
    expect(storage.presignedGetUrl).not.toHaveBeenCalled();
  });

  test("si el documento ya no es del ciudadano (p. ej. se transfirio y se borro) -> 404", async () => {
    const d1 = await documentoDe(ANA);
    await handler(aCarpeta([d1]));
    await Document.deleteOne({ _id: d1 });
    await descargar(d1).expect(404);
  });

  test("entidad NO verificada -> 403; token de ciudadano o sin token -> 401", async () => {
    const d1 = await documentoDe(ANA);
    await handler(aCarpeta([d1]));

    await descargar(d1, entityToken(EAFIT, false)).expect(403);
    const citizen = secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: ANA, expiresIn: 900 });
    await descargar(d1, citizen).expect(401);
    await request(app).get(`/api/v1/packages/${P1}/documents/${d1}/download`).expect(401);
  });
});
