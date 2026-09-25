/**
 * HU-10 (RF-11) de extremo a extremo dentro de ms-documentos: POST /api/v1/documents/inbound.
 *
 * Cadena real: requireEntityAuth (401) -> requireVerifiedEntity (403) -> multer -> controlador.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const AuditEntry = require("../src/domain/AuditEntry");
const SecretsManager = require("../src/security/SecretsManager");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const { DocumentService } = require("../src/application/DocumentService");
const { InboundDocumentService } = require("../src/application/InboundDocumentService");
const { makeCitizenRegisteredHandler } = require("../src/interfaces/eventHandlers");
const { pdf, makeFakeStorage, makeFakePublisher } = require("./helpers");

const CITIZEN_SECRET = "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAu";
const ENTITY_SECRET = "Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A";
const secrets = new SecretsManager({ active: CITIZEN_SECRET });
const entitySecrets = new SecretsManager({ active: ENTITY_SECRET });

const ANA = "665f1c04c9de9c4c34f6b52a";
const DIR_ANA = "1000000001-3f9c2ab7@carpetacolombia.co";
const EAFIT = "6aae9153b7655900026073f1";
const MAX_CIUDADANO = 10_000;
const MAX_INBOUND = 40_000;
const PATH = "/api/v1/documents/inbound";

let mongoServer;
let app;
let storage;
let publisher;

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
  await Promise.all([Folder.createIndexes(), Document.createIndexes(), AuditEntry.createIndexes()]);
  storage = makeFakeStorage();
  publisher = makeFakePublisher();
  const folderRepository = new FolderRepository();
  const documentRepository = new DocumentRepository();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const documentService = new DocumentService({
    documentRepository,
    folderRepository,
    storage,
    eventPublisher: publisher,
    auditLogger,
    quota: 5,
    maxUploadBytes: MAX_CIUDADANO,
    downloadTtlSeconds: 3600,
    eventPublishTimeoutMs: 500,
    now: () => new Date("2026-09-23T10:00:00Z"),
  });
  app = buildApp({
    documentService,
    inboundDocumentService: new InboundDocumentService({ documentService, documentRepository, folderRepository, maxInboundBytes: MAX_INBOUND }),
    secrets,
    entitySecrets,
    issuer: "ms-identidad",
    auditLogger,
    maxUploadBytes: MAX_CIUDADANO,
    maxInboundBytes: MAX_INBOUND,
  });

  await makeCitizenRegisteredHandler({ folderRepository })({ ciudadanoId: ANA, direccionUnica: DIR_ANA });
});

/** Token institucional tal como lo emite ms-comparticion (ADR-07). */
const entityToken = ({ ver = true, ...claims } = {}, options = {}) =>
  entitySecrets.sign({ typ: "access", act: "entidad", ver, ...claims }, { issuer: "ms-comparticion", subject: EAFIT, expiresIn: 900, ...options });
const citizenToken = (options = {}) => secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: ANA, expiresIn: 900, ...options });

const enviar = ({ token = entityToken(), campos = {}, archivo = pdf(400), nombre = "diploma.pdf", tipo = "application/pdf" } = {}) => {
  const base = { destinatario: DIR_ANA, envioId: "envio-2026-0001-abcdef", titulo: "Diploma de grado", entidadAvaladora: "Universidad EAFIT", fecha: "2026-03-15" };
  const campoFinal = { ...base, ...campos };
  let req = request(app).post(PATH);
  if (token) req = req.set("Authorization", `Bearer ${token}`);
  for (const [k, v] of Object.entries(campoFinal)) if (v !== undefined) req = req.field(k, v);
  return archivo ? req.attach("archivo", archivo, { filename: nombre, contentType: tipo }) : req;
};

describe("Happy path", () => {
  test("201 con el documentoId; el documento queda en la carpeta del CIUDADANO, certificado y con su procedencia", async () => {
    const res = await enviar().expect(201);

    expect(res.body).toEqual({ documentoId: expect.any(String), duplicado: false });
    expect(await Document.findById(res.body.documentoId).lean()).toMatchObject({
      ciudadanoId: ANA,
      estado: "certificado",
      origen: "entidad",
      emisorInstitutionId: EAFIT,
      envioId: "envio-2026-0001-abcdef",
    });
  });

  test("la respuesta NO expone la URL prefirmada ni la clave del storage", async () => {
    const res = await enviar().expect(201);

    expect(Object.keys(res.body).sort()).toEqual(["documentoId", "duplicado"]);
    expect(JSON.stringify(res.body)).not.toMatch(/storage|ciudadanos\/|http/);
  });

  test("el documento aparece en la consulta del ciudadano (HU-08) y no altera su cuota", async () => {
    await enviar().expect(201);

    const res = await request(app).get(`/api/v1/citizens/${ANA}/documents`).set("Authorization", `Bearer ${citizenToken()}`).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.documentos[0]).toMatchObject({ titulo: "Diploma de grado", estado: "certificado" });
    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).noCertificados).toBe(0);
  });

  test("un reintento del mismo envio responde 200 y no duplica nada", async () => {
    const primero = await enviar().expect(201);

    const reintento = await enviar().expect(200);

    expect(reintento.body).toEqual({ documentoId: primero.body.documentoId, duplicado: true });
    expect(await Document.countDocuments()).toBe(1);
  });

  test("el mismo envioId con otro contenido responde 409 y no pisa el documento anterior", async () => {
    await enviar().expect(201);

    const res = await enviar({ archivo: pdf(900) }).expect(409);

    expect(res.body.documentoId).toBeDefined();
    expect(await Document.countDocuments()).toBe(1);
  });
});

describe("Rechazos", () => {
  test("401 sin token, con token de CIUDADANO, expirado o de otro emisor -- y no se crea nada", async () => {
    const malos = [null, citizenToken(), entityToken({}, { expiresIn: -10 }), entityToken({}, { issuer: "ms-identidad" })];

    for (const token of malos) {
      const res = await enviar({ token });
      expect(res.status).toBe(401);
    }
    expect(await Document.countDocuments()).toBe(0);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test("403 si la entidad NO esta verificada (no 401: la credencial es valida, falta autorizacion)", async () => {
    const res = await enviar({ token: entityToken({ ver: false }) });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no esta verificada/);
    expect(await Document.countDocuments()).toBe(0);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test("404 si la direccion unica no corresponde a ningun ciudadano", async () => {
    const res = await enviar({ campos: { destinatario: "9999999999-aaaaaaaa@carpetacolombia.co" } });

    expect(res.status).toBe(404);
    expect(await Document.countDocuments()).toBe(0);
  });

  test("415 si no es PDF y 413 si supera el limite de la recepcion", async () => {
    await enviar({ archivo: Buffer.from("MZ ejecutable"), nombre: "virus.exe", tipo: "application/octet-stream" }).expect(415);
    await enviar({ campos: { envioId: "envio-2026-0002-abcdef" }, archivo: pdf(MAX_INBOUND + 5_000) }).expect(413);

    expect(await Document.countDocuments()).toBe(0);
  });

  test("acepta un archivo mayor que el maximo del ciudadano (el limite institucional es otro)", async () => {
    await enviar({ archivo: pdf(MAX_CIUDADANO + 5_000) }).expect(201);
  });

  test.each([
    ["sin destinatario", { destinatario: undefined }],
    ["sin envioId", { envioId: undefined }],
    ["envioId demasiado corto", { envioId: "abc" }],
    ["sin titulo", { titulo: undefined }],
    ["sin fecha", { fecha: undefined }],
  ])("400 %s", async (_name, campos) => {
    const res = await enviar({ campos });

    expect(res.status).toBe(400);
    expect(await Document.countDocuments()).toBe(0);
  });

  test("un ciudadanoId enviado en el cuerpo se IGNORA: el destinatario lo decide la direccion unica", async () => {
    const res = await enviar({ campos: { ciudadanoId: "665f1c04c9de9c4c34f6b52f" } }).expect(201);

    expect((await Document.findById(res.body.documentoId).lean()).ciudadanoId).toBe(ANA);
  });

  test("un token institucional no sirve en las rutas del ciudadano (HU-03/HU-08 intactas)", async () => {
    const t = entityToken();

    await request(app).get(`/api/v1/citizens/${ANA}/documents`).set("Authorization", `Bearer ${t}`).expect(401);
    await request(app).post(`/api/v1/citizens/${ANA}/documents`).set("Authorization", `Bearer ${t}`).field("titulo", "x").expect(401);
  });

  test("sin llavero institucional configurado la ruta responde 401 (falla cerrado)", async () => {
    const sinLlave = buildApp({ documentService: {}, inboundDocumentService: {}, secrets, issuer: "ms-identidad", auditLogger: {}, maxUploadBytes: MAX_CIUDADANO });

    await request(sinLlave).post(PATH).set("Authorization", `Bearer ${entityToken()}`).field("destinatario", DIR_ANA).expect(401);
  });
});

describe("Auditoria e integridad", () => {
  test("la entrega queda auditada como accion delegada de la entidad sobre la carpeta del ciudadano", async () => {
    const res = await enviar().expect(201);

    expect(await AuditEntry.findOne({ action: "documento.recibir", outcome: "exito" }).lean()).toMatchObject({
      actor: EAFIT,
      actorType: "entidad",
      resource: `documento:${res.body.documentoId}`,
      resourceOwner: ANA,
      delegated: true,
    });
  });

  test("el rechazo por entidad no verificada tambien queda auditado", async () => {
    await enviar({ token: entityToken({ ver: false }) }).expect(403);

    expect(await AuditEntry.findOne({ outcome: "rechazo" }).lean()).toMatchObject({
      actor: EAFIT,
      actorType: "entidad",
      reason: "entidad_no_verificada",
    });
  });

  test("el trace-id del cliente llega hasta la bitacora (HT-06)", async () => {
    const res = await request(app)
      .post(PATH)
      .set("Authorization", `Bearer ${entityToken()}`)
      .set("x-trace-id", "traza-entidad-0001")
      .field("destinatario", DIR_ANA)
      .field("envioId", "envio-2026-0003-abcdef")
      .field("titulo", "Diploma")
      .field("entidadAvaladora", "Universidad EAFIT")
      .field("fecha", "2026-03-15")
      .attach("archivo", pdf(300), { filename: "d.pdf", contentType: "application/pdf" })
      .expect(201);

    expect(res.headers["x-trace-id"]).toBe("traza-entidad-0001");
    expect((await AuditEntry.findOne({ action: "documento.recibir" }).lean()).traceId).toBe("traza-entidad-0001");
  });

  test("se publica el evento documento.cargado del ciudadano destinatario (consumidor de HU-03 reutilizado)", async () => {
    const res = await enviar().expect(201);

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [routingKey, payload] = publisher.publish.mock.calls[0];
    expect(routingKey).toBe("documento.cargado");
    expect(payload).toMatchObject({ eventId: res.body.documentoId, ciudadanoId: ANA, estado: "certificado" });
  });
});
