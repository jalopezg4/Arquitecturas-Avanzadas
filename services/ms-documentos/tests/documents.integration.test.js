const request = require("supertest");
const express = require("express");
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
const requireAuth = require("../src/security/requireAuth");
const logger = require("../src/tracing/logger");
const { DocumentService } = require("../src/application/DocumentService");
const { pdf, makeFakeStorage, makeFakePublisher, validMeta } = require("./helpers");

const SECRET = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const OTHER_SECRET = "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAu";
const ANA = "6aae9153b7655900026073f1";
const BETO = "6aae9153b7655900026073f2";
const MAX_BYTES = 200 * 1024;

// A nivel de modulo: test.each arma sus filas al DEFINIR las pruebas, antes de cualquier beforeEach.
const secrets = new SecretsManager({ active: SECRET });

let mongoServer;
let storage;
let publisher;
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

beforeEach(() => {
  storage = makeFakeStorage();
  publisher = makeFakePublisher();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const documentService = new DocumentService({
    documentRepository: new DocumentRepository(),
    folderRepository: new FolderRepository(),
    storage,
    eventPublisher: publisher,
    auditLogger,
    quota: 5,
    maxUploadBytes: MAX_BYTES,
    downloadTtlSeconds: 3600,
    eventPublishTimeoutMs: 300,
  });
  app = buildApp({ documentService, secrets, issuer: "ms-identidad", auditLogger, maxUploadBytes: MAX_BYTES });
});

/** Token de acceso como los que firma ms-identidad en el login. */
const accessFor = (ciudadanoId, options = {}, keyRing = secrets, claims = {}) => keyRing.sign({ typ: "access", ...claims }, { issuer: "ms-identidad", subject: ciudadanoId, expiresIn: 900, ...options });

function post(ciudadanoId, { token = accessFor(ANA), buffer = pdf(), filename = "diploma.pdf", contentType = "application/pdf", fields = validMeta, fieldName = "archivo" } = {}) {
  let req = request(app).post(`/api/v1/citizens/${ciudadanoId}/documents`);
  if (token) req = req.set("Authorization", `Bearer ${token}`);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) req = req.field(k, v);
  if (buffer) req = req.attach(fieldName, buffer, { filename, contentType });
  return req;
}

describe("POST /api/v1/citizens/:id/documents (integracion)", () => {
  test("201 {documentoId, url}: guarda metadatos temporales, sube el archivo y publica el evento", async () => {
    const res = await post(ANA).expect(201);

    expect(Object.keys(res.body).sort()).toEqual(["documentoId", "url"]);
    expect(res.body.url).toContain(`ciudadanos/${ANA}/`);
    const doc = await Document.findById(res.body.documentoId).lean();
    expect(doc).toMatchObject({ ciudadanoId: ANA, titulo: "Diploma de grado", estado: "temporal" });
    expect(storage.objects.get(doc.storageKey).body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(publisher.publish).toHaveBeenCalledWith("documento.cargado", expect.objectContaining({ documentoId: res.body.documentoId, ciudadanoId: ANA }));
  });

  test("devuelve el x-trace-id y no anuncia el framework", async () => {
    const res = await post(ANA).set("x-trace-id", "traza-cliente-0001").expect(201);
    expect(res.headers["x-trace-id"]).toBe("traza-cliente-0001");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  test("la carga queda en la bitacora enlazada al trace-id del request (HT-06)", async () => {
    await post(ANA).expect(201);
    const entry = await AuditEntry.findOne({ action: "documento.cargar" }).lean();
    expect(entry).toMatchObject({ actor: ANA, outcome: "exito" });
    expect(entry.traceId).toBeTruthy();
  });

  test("el trace-id del cliente llega a la bitacora y a los logs DESPUES de leer el archivo (multer no rompe el contexto)", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));
    publisher.publish.mockRejectedValue(new Error("nack")); // fuerza un log dentro del servicio, ya tras multer

    await post(ANA).set("x-trace-id", "traza-cliente-0002").expect(201);

    expect((await AuditEntry.findOne({ action: "documento.cargar" }).lean()).traceId).toBe("traza-cliente-0002");
    const inService = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "documento.evento_no_publicado");
    expect(inService.traceId).toBe("traza-cliente-0002");
  });

  test("tambien en un rechazo por archivo invalido el error queda con el trace-id del cliente", async () => {
    const res = await post(ANA, { buffer: Buffer.from("no soy pdf"), contentType: "image/png", filename: "a.png" }).set("x-trace-id", "traza-cliente-0003");
    expect(res.status).toBe(415);
    expect(res.headers["x-trace-id"]).toBe("traza-cliente-0003");
  });

  test("RF-30: acepta solicitudId opcional con el mismo mecanismo de carga temporal", async () => {
    const res = await post(ANA, { fields: { ...validMeta, solicitudId: "sol-77" } }).expect(201);
    expect((await Document.findById(res.body.documentoId).lean()).solicitudId).toBe("sol-77");
  });
});

describe("Autenticacion: el servicio revalida el token por si mismo (ADR-06)", () => {
  test.each([
    ["sin token", { token: null }],
    ["token basura", { token: "no.es.un-jwt" }],
    ["token expirado", { token: accessFor(ANA, { expiresIn: -10 }) }],
    ["firmado con otra llave", { token: accessFor(ANA, {}, new SecretsManager({ active: OTHER_SECRET })) }],
    ["un refresh token", { token: accessFor(ANA, {}, secrets, { typ: "refresh" }) }],
    ["otro emisor", { token: accessFor(ANA, { issuer: "otro-servicio" }) }],
  ])("401 con %s -- y no se guarda ni se sube nada", async (_name, options) => {
    const res = await post(ANA, options);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "token invalido o expirado" });
    expect(storage.put).not.toHaveBeenCalled();
    expect(await Document.countDocuments()).toBe(0);
  });

  test("un servicio con su propio llavero acepta el token que firmo ms-identidad (mismo criterio en cada servicio)", async () => {
    const other = express();
    other.get("/x", requireAuth(new SecretsManager({ active: SECRET })), (req, res) => res.json({ sub: req.auth.ciudadanoId }));
    await request(other).get("/x").set("Authorization", `Bearer ${accessFor(ANA)}`).expect(200, { sub: ANA });
  });
});

describe("Ownership: solo el dueno carga en su propia carpeta", () => {
  test("403 si el token es de Beto y la carpeta es de Ana; nada se guarda y queda en la bitacora", async () => {
    const res = await post(ANA, { token: accessFor(BETO) });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/dueno/);
    expect(storage.put).not.toHaveBeenCalled();
    expect(await Document.countDocuments()).toBe(0);
    expect(await Folder.countDocuments()).toBe(0); // ni siquiera se toco la carpeta ajena
    const entry = await AuditEntry.findOne({ outcome: "rechazo" }).lean();
    expect(entry).toMatchObject({ action: "documento.cargar", actor: BETO, resourceOwner: ANA, reason: "no_es_dueno" });
  });

  test("el dueno se comprueba ANTES de leer el archivo: un ajeno con un archivo invalido recibe 403, no 415", async () => {
    const res = await post(ANA, { token: accessFor(BETO), buffer: Buffer.from("MZ ejecutable"), filename: "x.exe", contentType: "application/pdf" });
    expect(res.status).toBe(403);
  });

  test("cada quien puede cargar en su propia carpeta", async () => {
    await post(ANA).expect(201);
    await post(BETO, { token: accessFor(BETO) }).expect(201);
    expect(await Document.countDocuments()).toBe(2);
  });
});

describe("Cuota de no certificados", () => {
  test("409 en el sexto documento con el limite y sin subir el archivo", async () => {
    for (let i = 0; i < 5; i++) await post(ANA).expect(201);
    storage.put.mockClear();

    const res = await post(ANA);

    expect(res.status).toBe(409);
    expect(res.body.limite).toBe(5);
    expect(res.body.error).toMatch(/certifica o elimina/i);
    expect(storage.put).not.toHaveBeenCalled();
    expect(await Document.countDocuments()).toBe(5);
  });

  test("10 cargas simultaneas por HTTP -> exactamente 5 exitos y 5 x 409", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => post(ANA)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await Document.countDocuments()).toBe(5);
  });
});

describe("Validacion del archivo y los metadatos", () => {
  test("415 si no es PDF (por tipo declarado)", async () => {
    const res = await post(ANA, { buffer: Buffer.from("PNG..."), filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(415);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test("415 si declara PDF pero el contenido no es un PDF", async () => {
    const res = await post(ANA, { buffer: Buffer.from("MZ\x90\x00 ejecutable disfrazado") });
    expect(res.status).toBe(415);
    expect(await Folder.countDocuments()).toBe(0);
  });

  test("413 si supera el tamano maximo, sin reservar cuota ni subir nada", async () => {
    const res = await post(ANA, { buffer: pdf(MAX_BYTES + 1024) });
    expect(res.status).toBe(413);
    expect(storage.put).not.toHaveBeenCalled();
    expect(await Folder.countDocuments()).toBe(0);
  });

  test.each([
    ["sin titulo", { ...validMeta, titulo: undefined }],
    ["sin entidad avaladora", { ...validMeta, entidadAvaladora: undefined }],
    ["fecha invalida", { ...validMeta, fecha: "manana" }],
    ["fecha en el futuro", { ...validMeta, fecha: "2999-01-01" }],
  ])("400 %s", async (_name, fields) => {
    const res = await post(ANA, { fields });
    expect(res.status).toBe(400);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test("400 sin archivo (solo campos)", async () => {
    const res = await post(ANA, { buffer: null });
    expect(res.status).toBe(400);
  });

  test("400 si el archivo llega en un campo distinto de archivo", async () => {
    const res = await post(ANA, { fieldName: "otro" });
    expect(res.status).toBe(400);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test("400 si envian mas de un archivo", async () => {
    const res = await request(app)
      .post(`/api/v1/citizens/${ANA}/documents`)
      .set("Authorization", `Bearer ${accessFor(ANA)}`)
      .field("titulo", "x")
      .attach("archivo", pdf(), { filename: "a.pdf", contentType: "application/pdf" })
      .attach("archivo", pdf(), { filename: "b.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test("400 si el cuerpo no es multipart (JSON)", async () => {
    const res = await request(app).post(`/api/v1/citizens/${ANA}/documents`).set("Authorization", `Bearer ${accessFor(ANA)}`).send({ titulo: "x" });
    expect(res.status).toBe(400);
  });

  test("el nombre del archivo del usuario nunca entra en la clave del objeto (sin recorrido de rutas)", async () => {
    const res = await post(ANA, { filename: "../../etc/passwd.pdf" }).expect(201);
    const doc = await Document.findById(res.body.documentoId).lean();
    expect(doc.storageKey).toMatch(new RegExp(`^ciudadanos/${ANA}/[0-9a-f-]{36}\\.pdf$`));
  });
});

describe("Fallos de infraestructura", () => {
  test("503 generico si el storage no responde; sin detalles internos y el cupo se devuelve", async () => {
    storage.failPut = true;

    const res = await post(ANA);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "El almacenamiento de documentos no esta disponible" });
    expect(JSON.stringify(res.body)).not.toMatch(/storage caido|Error:/);
    storage.failPut = false;
    for (let i = 0; i < 5; i++) await post(ANA).expect(201); // el cupo no se perdio
  });

  test("si el broker no responde, la carga responde 201 igual (la notificacion no es camino critico)", async () => {
    publisher.publish.mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    const res = await post(ANA).expect(201);

    expect(Date.now() - started).toBeLessThan(3000);
    expect((await Document.findById(res.body.documentoId).lean()).eventoPublicado).toBe(false);
  });

  test("los logs del request no contienen el titulo del documento ni el token", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));
    const token = accessFor(ANA);
    publisher.publish.mockRejectedValue(new Error("nack"));

    await post(ANA, { token }).expect(201);

    const dump = lines.join("\n");
    expect(dump).toContain("documento.evento_no_publicado");
    expect(dump).not.toContain("Diploma de grado");
    expect(dump).not.toContain(token);
  });
});

describe("GET /api/v1/citizens/:id/documents (integracion, HU-08)", () => {
  const get = (ciudadanoId, { token = accessFor(ANA), query = "" } = {}) => {
    const req = request(app).get(`/api/v1/citizens/${ciudadanoId}/documents${query}`);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  test("200 con la forma {documentos, total, currentPage, pageSize, totalPages}; lista lo cargado por HU-03", async () => {
    await post(ANA).expect(201);
    await post(ANA, { fields: { ...validMeta, titulo: "Cedula" } }).expect(201);

    const res = await get(ANA).expect(200);

    expect(Object.keys(res.body).sort()).toEqual(["currentPage", "documentos", "pageSize", "total", "totalPages"]);
    expect(res.body).toMatchObject({ total: 2, currentPage: 1, pageSize: 10, totalPages: 1 });
    expect(res.body.documentos.map((d) => d.titulo).sort()).toEqual(["Cedula", "Diploma de grado"]);
    expect(res.body.documentos[0]).toMatchObject({ estado: "temporal", entidadAvaladora: "Universidad EAFIT" });
    expect(JSON.stringify(res.body)).not.toMatch(/storageKey|sha256/);
  });

  test("respeta page y pageSize del query string", async () => {
    for (let i = 0; i < 3; i++) await post(ANA).expect(201);

    const res = await get(ANA, { query: "?page=2&pageSize=2" }).expect(200);

    expect(res.body).toMatchObject({ total: 3, currentPage: 2, pageSize: 2, totalPages: 2 });
    expect(res.body.documentos).toHaveLength(1);
  });

  test("carpeta vacia -> 200 con documentos:[] y total:0", async () => {
    const res = await get(ANA).expect(200);
    expect(res.body).toMatchObject({ documentos: [], total: 0 });
  });

  test("403 si el token es de Beto y la carpeta es de Ana: no ve nada y queda en la bitacora como consulta rechazada", async () => {
    await post(ANA).expect(201);

    const res = await get(ANA, { token: accessFor(BETO) });

    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty("documentos");
    const entry = await AuditEntry.findOne({ action: "documento.consultar" }).lean();
    expect(entry).toMatchObject({ outcome: "rechazo", actor: BETO, resourceOwner: ANA, reason: "no_es_dueno" });
  });

  test("cada quien ve solo lo suyo", async () => {
    await post(ANA).expect(201);
    await post(BETO, { token: accessFor(BETO), fields: { ...validMeta, titulo: "De Beto" } }).expect(201);

    const beto = await get(BETO, { token: accessFor(BETO) }).expect(200);

    expect(beto.body.documentos.map((d) => d.titulo)).toEqual(["De Beto"]);
  });

  test.each([
    ["sin token", { token: null }],
    ["token expirado", { token: accessFor(ANA, { expiresIn: -10 }) }],
    ["firmado con otra clave", { token: accessFor(ANA, {}, new SecretsManager({ active: OTHER_SECRET })) }],
    ["un refresh token", { token: accessFor(ANA, {}, secrets, { typ: "refresh" }) }],
  ])("401 %s (el servicio revalida el JWT, no confia solo en el gateway)", async (_name, opts) => {
    await get(ANA, opts).expect(401);
  });

  test.each([["?page=0"], ["?page=abc"], ["?pageSize=-1"], ["?page=1&page=2"], ["?page[$gt]="]])("400 con query invalido %s", async (query) => {
    await get(ANA, { query }).expect(400);
  });

  test("un pageSize por encima del maximo se limita a 100", async () => {
    const res = await get(ANA, { query: "?pageSize=1000" }).expect(200);
    expect(res.body.pageSize).toBe(100);
  });
});
