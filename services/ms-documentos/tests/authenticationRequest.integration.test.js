/**
 * HU-04, ola 2: PUT /api/v1/documents/:id/authenticate en ms-documentos. Marca el documento `en autenticacion`,
 * publica `documento.autenticacion_solicitada` y responde 202 sin esperar a GovCarpeta (RNF-10).
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
const SecretsManager = require("../src/security/SecretsManager");
const { DocumentService } = require("../src/application/DocumentService");
const { DocumentAuthenticationService } = require("../src/application/DocumentAuthenticationService");
const AuthenticationRequestReconciler = require("../src/application/AuthenticationRequestReconciler");
const { makeFakeStorage, makeFakePublisher } = require("./helpers");

const SECRET = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const ANA = "6aae9153b7655900026073f1";
const BETO = "6aae9153b7655900026073f2";
const CEDULA_ANA = 1000000001;
const NOW = new Date("2026-09-26T15:00:00Z");

const secrets = new SecretsManager({ active: SECRET });
const accessFor = (ciudadanoId) => secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: ciudadanoId, expiresIn: 900 });

let mongoServer;
let publisher;
let app;
let authService;
let documentRepository;
let folderRepository;

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

function build(publisherImpl) {
  publisher = makeFakePublisher(publisherImpl);
  documentRepository = new DocumentRepository();
  folderRepository = new FolderRepository();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const documentService = new DocumentService({ documentRepository, folderRepository, storage: makeFakeStorage(), eventPublisher: publisher, auditLogger, quota: 5, maxUploadBytes: 1024, downloadTtlSeconds: 3600 });
  authService = new DocumentAuthenticationService({ documentRepository, folderRepository, eventPublisher: publisher, auditLogger, eventPublishTimeoutMs: 200, now: () => NOW });
  app = buildApp({ documentService, documentAuthenticationService: authService, secrets, issuer: "ms-identidad", auditLogger, maxUploadBytes: 1024 });
}
beforeEach(() => build());

let n = 0;
async function documentoDe(ciudadanoId, extra = {}) {
  n += 1;
  return Document.create({
    ciudadanoId,
    titulo: "Diploma de grado",
    entidadAvaladora: "EAFIT",
    fecha: new Date("2026-03-15"),
    storageKey: `ciudadanos/${ciudadanoId}/doc-${n}.pdf`,
    mimeType: "application/pdf",
    tamanoBytes: 100,
    sha256: "a".repeat(64),
    eventoPublicado: true,
    ...extra,
  });
}
const conCedula = (ciudadanoId = ANA, documento = CEDULA_ANA) => Folder.create({ ciudadanoId, documento, noCertificados: 1 });
const authenticate = (id, token = accessFor(ANA)) => {
  const req = request(app).put(`/api/v1/documents/${id}/authenticate`);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
};

describe("PUT /api/v1/documents/:id/authenticate", () => {
  test("202: marca 'en autenticacion' y publica la solicitud con la cedula, la clave del objeto y el intento", async () => {
    await conCedula();
    const doc = await documentoDe(ANA);

    const res = await authenticate(doc._id).expect(202);

    expect(res.body).toEqual({ documentoId: String(doc._id), estado: "en autenticacion" });
    expect((await Document.findById(doc._id).lean()).estado).toBe("en autenticacion");
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [routingKey, payload] = publisher.publish.mock.calls[0];
    expect(routingKey).toBe("documento.autenticacion_solicitada");
    expect(payload).toEqual({
      eventId: `${doc._id}-auth-1`,
      documentoId: String(doc._id),
      ciudadanoId: ANA,
      documento: CEDULA_ANA,
      titulo: "Diploma de grado",
      storageKey: doc.storageKey,
      intento: 1,
      solicitadaEn: NOW.toISOString(),
    });
    expect((await Document.findById(doc._id).lean()).autenticacionEventoPublicado).toBe(true);
  });

  test("la respuesta no expone la clave del storage ni la cedula", async () => {
    await conCedula();
    const doc = await documentoDe(ANA);

    const res = await authenticate(doc._id).expect(202);

    expect(JSON.stringify(res.body)).not.toContain("ciudadanos/");
    expect(JSON.stringify(res.body)).not.toContain(String(CEDULA_ANA));
  });

  test("responde 202 aunque el broker no confirme: la solicitud queda pendiente de reenvio (ADR-04)", async () => {
    build(() => new Promise(() => {})); // el broker nunca responde
    await conCedula();
    const doc = await documentoDe(ANA);

    await authenticate(doc._id).expect(202);

    expect(await Document.findById(doc._id).lean()).toMatchObject({ estado: "en autenticacion", autenticacionEventoPublicado: false });
  });

  test("401 sin token: el documento no cambia", async () => {
    await conCedula();
    const doc = await documentoDe(ANA);

    await authenticate(doc._id, null).expect(401);

    expect((await Document.findById(doc._id).lean()).estado).toBe("temporal");
  });

  test("403 si el documento es de otro ciudadano: no cambia y queda en la bitacora como no_es_dueno", async () => {
    await conCedula(BETO, 1000000002);
    const doc = await documentoDe(BETO);

    await authenticate(doc._id).expect(403);

    expect((await Document.findById(doc._id).lean()).estado).toBe("temporal");
    expect(publisher.publish).not.toHaveBeenCalled();
    const entry = await AuditEntry.findOne({ action: "documento.autenticar" }).lean();
    expect(entry).toMatchObject({ actor: ANA, resourceOwner: BETO, outcome: "rechazo", reason: "no_es_dueno" });
  });

  test.each([["665f1c04c9de9c4c34f6b599"], ["no-es-un-id"]])("404 si el documento no existe (%s)", async (id) => {
    await conCedula();
    await authenticate(id).expect(404);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  test.each([["certificado"], ["en autenticacion"]])("400 si el documento esta %s", async (estado) => {
    await conCedula();
    const doc = await documentoDe(ANA, { estado });

    const res = await authenticate(doc._id).expect(400);

    expect(res.body.error).toBe("el documento no esta disponible para autenticacion");
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  test("409 si la carpeta aun no tiene la cedula: el documento sigue temporal (se puede reintentar)", async () => {
    await Folder.create({ ciudadanoId: ANA }); // carpeta creada por una carga, antes del evento ciudadano.registrado
    const doc = await documentoDe(ANA);

    await authenticate(doc._id).expect(409);

    expect((await Document.findById(doc._id).lean()).estado).toBe("temporal");
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  test("dos solicitudes simultaneas: una 202 y la otra 400, un solo evento", async () => {
    await conCedula();
    const doc = await documentoDe(ANA);

    const codes = (await Promise.all([authenticate(doc._id), authenticate(doc._id)])).map((r) => r.status).sort();

    expect(codes).toEqual([202, 400]);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  test("el listado de la carpeta (HU-08) muestra el estado 'en autenticacion'", async () => {
    await conCedula();
    const doc = await documentoDe(ANA);
    await authenticate(doc._id).expect(202);

    const res = await request(app).get(`/api/v1/citizens/${ANA}/documents`).set("Authorization", `Bearer ${accessFor(ANA)}`).expect(200);

    expect(res.body.documentos[0].estado).toBe("en autenticacion");
  });
});

describe("AuthenticationRequestReconciler", () => {
  const reconciler = (overrides = {}) =>
    new AuthenticationRequestReconciler({ documentRepository, folderRepository, authenticationService: authService, minAgeMs: 60000, now: () => new Date(NOW.getTime() + 120000), ...overrides });

  test("reenvia la solicitud que el broker no confirmo, con el MISMO eventId, y la marca publicada", async () => {
    let fallar = true;
    build(async () => {
      if (fallar) throw new Error("broker caido");
    });
    await conCedula();
    const doc = await documentoDe(ANA);
    await authenticate(doc._id).expect(202);
    const primerEventId = publisher.publish.mock.calls[0][1].eventId;

    fallar = false;
    expect(await reconciler().reconcileOnce()).toEqual({ republished: 1, failed: 0 });

    expect(publisher.publish.mock.calls[1][1].eventId).toBe(primerEventId);
    expect((await Document.findById(doc._id).lean()).autenticacionEventoPublicado).toBe(true);
    expect(await reconciler().reconcileOnce()).toEqual({ republished: 0, failed: 0 });
  });

  test("no toca una solicitud mas reciente que minAgeMs", async () => {
    build(async () => {
      throw new Error("broker caido");
    });
    await conCedula();
    const doc = await documentoDe(ANA);
    await authenticate(doc._id).expect(202);

    expect(await reconciler({ now: () => NOW }).reconcileOnce()).toEqual({ republished: 0, failed: 0 });
  });
});
