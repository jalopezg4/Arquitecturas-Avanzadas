const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const AuditEntry = require("../src/domain/AuditEntry");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const logger = require("../src/tracing/logger");
const { DocumentService, ValidationError, UnsupportedMediaTypeError, PayloadTooLargeError, QuotaExceededError, StorageUnavailableError } = require("../src/application/DocumentService");
const { pdf, makeFakeStorage, makeFakePublisher, validMeta } = require("./helpers");

const OWNER = "6aae9153b7655900026073f1";
const QUOTA = 5;
const MAX_BYTES = 1024 * 1024;

let mongoServer;
let storage;
let publisher;
let service;

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

function build(overrides = {}) {
  storage = overrides.storage || makeFakeStorage();
  publisher = overrides.publisher || makeFakePublisher();
  return new DocumentService({
    documentRepository: overrides.documentRepository || new DocumentRepository(),
    folderRepository: new FolderRepository(),
    storage,
    eventPublisher: publisher,
    auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
    quota: QUOTA,
    maxUploadBytes: MAX_BYTES,
    downloadTtlSeconds: 3600,
    eventPublishTimeoutMs: overrides.eventPublishTimeoutMs ?? 500,
    now: () => new Date("2026-09-20T10:00:00Z"),
  });
}
beforeEach(() => {
  service = build();
});

const file = (size) => ({ buffer: pdf(size), mimetype: "application/pdf" });
const upload = (extra = {}) => service.upload({ ciudadanoId: OWNER, file: file(), metadata: validMeta, ...extra });
const fill = async (n) => {
  for (let i = 0; i < n; i++) await upload();
};

describe("DocumentService.upload() -- carga exitosa", () => {
  test("persiste en estado temporal con los metadatos completos y devuelve {documentoId, url}", async () => {
    const res = await upload();

    expect(Object.keys(res).sort()).toEqual(["documentoId", "url"]);
    const doc = await Document.findById(res.documentoId).lean();
    expect(doc).toMatchObject({ ciudadanoId: OWNER, titulo: "Diploma de grado", entidadAvaladora: "Universidad EAFIT", estado: "temporal", mimeType: "application/pdf", eventoPublicado: true });
    expect(doc.fecha.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(doc.createdAt).toBeInstanceOf(Date); // fecha de carga (RF-20)
  });

  test("guarda SOLO la clave del objeto en Mongo, nunca el binario", async () => {
    const buffer = pdf(50_000);
    const res = await service.upload({ ciudadanoId: OWNER, file: { buffer, mimetype: "application/pdf" }, metadata: validMeta });

    const raw = await Document.collection.findOne({});
    expect(raw.storageKey).toMatch(new RegExp(`^ciudadanos/${OWNER}/[0-9a-f-]{36}\\.pdf$`));
    expect(JSON.stringify(raw).length).toBeLessThan(2000); // un binario de 50 KB no cabe en este documento
    expect(raw).not.toHaveProperty("archivo");
    expect(raw).not.toHaveProperty("contenido");
    expect(storage.objects.get(raw.storageKey).body).toBe(buffer); // el binario esta en el storage
    expect(res.url).toContain(raw.storageKey);
  });

  test("guarda la huella SHA-256 del contenido y el tamano", async () => {
    const buffer = pdf(300);
    await service.upload({ ciudadanoId: OWNER, file: { buffer, mimetype: "application/pdf" }, metadata: validMeta });

    const doc = await Document.findOne().lean();
    expect(doc.sha256).toBe(require("crypto").createHash("sha256").update(buffer).digest("hex"));
    expect(doc.tamanoBytes).toBe(300);
  });

  test("la URL se firma con la vigencia configurada (ADR-06: 1 hora como maximo)", async () => {
    await upload();
    expect(storage.presignedGetUrl).toHaveBeenCalledWith(expect.any(String), 3600);
  });

  test("RF-30: la carga temporal por documento faltante usa el mismo metodo y guarda la solicitud vinculada", async () => {
    await upload({ metadata: { ...validMeta, solicitudId: "sol-123" } });
    await upload();

    const docs = await Document.find().sort({ createdAt: 1 }).lean();
    expect(docs.map((d) => [d.estado, d.solicitudId])).toEqual([["temporal", "sol-123"], ["temporal", null]]);
  });
});

describe("DocumentService.upload() -- cuota de documentos no certificados (RNF-04)", () => {
  test("rechaza el sexto documento (cuota 5) SIN subir el archivo, con 409", async () => {
    await fill(QUOTA);
    storage.put.mockClear();

    const err = await upload().catch((e) => e);

    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.limit).toBe(QUOTA);
    expect(err.message).toMatch(/certifica o elimina/i); // sugiere que hacer
    expect(storage.put).not.toHaveBeenCalled();
    expect(await Document.countDocuments()).toBe(QUOTA);
  });

  test("un documento CERTIFICADO no aplica ni consume cuota, aunque la cuota este llena", async () => {
    await fill(QUOTA);

    await upload({ estado: "certificado" });
    await upload({ estado: "certificado" });

    expect(await Document.countDocuments({ estado: "certificado" })).toBe(2);
    expect((await Folder.findOne({ ciudadanoId: OWNER }).lean()).noCertificados).toBe(QUOTA); // sigue en 5
  });

  test("la cuota es por ciudadano: la carpeta llena de uno no afecta a otro", async () => {
    await fill(QUOTA);

    await expect(service.upload({ ciudadanoId: "otro-ciudadano-1", file: file(), metadata: validMeta })).resolves.toHaveProperty("documentoId");
  });

  test("CONCURRENCIA: 8 cargas simultaneas con cuota 5 -> exactamente 5 exitos y 3 rechazos (reserva atomica)", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => upload().catch((e) => e)));

    expect(results.filter((r) => r.documentoId)).toHaveLength(5);
    expect(results.filter((r) => r instanceof QuotaExceededError)).toHaveLength(3);
    expect(await Document.countDocuments()).toBe(5);
    expect(storage.put).toHaveBeenCalledTimes(5); // los 3 rechazados nunca subieron nada
    expect((await Folder.findOne({ ciudadanoId: OWNER }).lean()).noCertificados).toBe(5);
  });

  test("un rechazo por cuota queda en la bitacora como rechazo", async () => {
    await fill(QUOTA);
    await upload().catch(() => {});

    const entry = await AuditEntry.findOne({ outcome: "rechazo" }).lean();
    expect(entry).toMatchObject({ action: "documento.cargar", actor: OWNER, reason: "cuota_llena" });
  });
});

describe("DocumentService.upload() -- fallos a mitad de camino no dejan basura (compensacion)", () => {
  test("si el storage falla: 503, se devuelve el cupo y no queda documento", async () => {
    storage.failPut = true;

    const err = await upload().catch((e) => e);

    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(await Document.countDocuments()).toBe(0);
    expect((await Folder.findOne({ ciudadanoId: OWNER }).lean()).noCertificados).toBe(0); // el cupo volvio
    storage.failPut = false;
    await fill(QUOTA); // y aun se pueden cargar los 5 completos
  });

  test("si falla guardar los metadatos: se BORRA el objeto ya subido y se devuelve el cupo", async () => {
    const failing = { create: async () => { throw new Error("mongo caido"); }, markEventPublished: async () => {} };
    service = build({ documentRepository: failing });

    await expect(upload()).rejects.toThrow("mongo caido");

    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.objects.size).toBe(0); // ningun objeto huerfano
    expect((await Folder.findOne({ ciudadanoId: OWNER }).lean()).noCertificados).toBe(0);
  });

  test("si la compensacion tambien falla, se reporta en el log y el error original es el que se propaga", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(l));
    const failing = { create: async () => { throw new Error("mongo caido"); }, markEventPublished: async () => {} };
    service = build({ documentRepository: failing });
    storage.delete.mockRejectedValue(new Error("storage tambien caido"));

    await expect(upload()).rejects.toThrow("mongo caido");

    expect(lines.join("\n")).toContain("documento.compensacion_fallo");
  });
});

describe("DocumentService.upload() -- evento DocumentoCargado y respuesta sin esperar al consumidor", () => {
  test("publica documento.cargado con eventId, documentoId, ciudadanoId, titulo y estado", async () => {
    const res = await upload();

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [routingKey, payload] = publisher.publish.mock.calls[0];
    expect(routingKey).toBe("documento.cargado");
    expect(payload).toMatchObject({ documentoId: res.documentoId, ciudadanoId: OWNER, titulo: "Diploma de grado", entidadAvaladora: "Universidad EAFIT", estado: "temporal" });
    expect(payload.eventId).toBe(res.documentoId); // deterministico: un reenvio del mismo documento es el MISMO evento
    expect(payload.cargadoEn).toBeTruthy();
  });

  test("cada documento lleva un eventId distinto", async () => {
    await fill(2);
    const ids = publisher.publish.mock.calls.map((c) => c[1].eventId);
    expect(new Set(ids).size).toBe(2);
  });

  test("si el broker NO responde nunca, la carga responde igual tras el plazo y queda marcada para reconciliar", async () => {
    service = build({ publisher: makeFakePublisher(() => new Promise(() => {})), eventPublishTimeoutMs: 150 });
    const lines = [];
    logger.setSink((l) => lines.push(l));

    const started = Date.now();
    const res = await upload();

    expect(res.documentoId).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(2000); // no se quedo esperando al consumidor
    expect((await Document.findById(res.documentoId).lean()).eventoPublicado).toBe(false);
    expect(lines.join("\n")).toContain("documento.evento_no_publicado");
  });

  test("si el broker rechaza el mensaje, la carga NO falla (ADR-04) y queda eventoPublicado=false", async () => {
    service = build({ publisher: makeFakePublisher(async () => { throw new Error("nack"); }) });

    const res = await upload();

    expect(res.documentoId).toBeTruthy();
    expect((await Document.findById(res.documentoId).lean()).eventoPublicado).toBe(false);
    expect(await Document.countDocuments()).toBe(1);
  });
});

describe("DocumentService.upload() -- validaciones (no tocan cuota, storage ni broker)", () => {
  const noSideEffects = async () => {
    expect(storage.put).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(await Folder.countDocuments()).toBe(0);
  };

  test.each([
    ["sin archivo", { file: undefined }, ValidationError],
    ["archivo vacio", { file: { buffer: Buffer.alloc(0), mimetype: "application/pdf" } }, ValidationError],
    ["tipo declarado que no es PDF", { file: { buffer: pdf(), mimetype: "image/png" } }, UnsupportedMediaTypeError],
    ["declara PDF pero el contenido no lo es", { file: { buffer: Buffer.from("MZ\x90\x00 ejecutable"), mimetype: "application/pdf" } }, UnsupportedMediaTypeError],
    ["archivo por encima del maximo", { file: { buffer: pdf(MAX_BYTES + 1), mimetype: "application/pdf" } }, PayloadTooLargeError],
    ["sin titulo", { metadata: { ...validMeta, titulo: "  " } }, ValidationError],
    ["titulo demasiado largo", { metadata: { ...validMeta, titulo: "x".repeat(201) } }, ValidationError],
    ["sin entidad avaladora", { metadata: { ...validMeta, entidadAvaladora: undefined } }, ValidationError],
    ["fecha invalida", { metadata: { ...validMeta, fecha: "ayer" } }, ValidationError],
    ["fecha en el futuro", { metadata: { ...validMeta, fecha: "2027-01-01" } }, ValidationError],
    ["fecha absurda", { metadata: { ...validMeta, fecha: "1500-01-01" } }, ValidationError],
    ["solicitudId con caracteres raros", { metadata: { ...validMeta, solicitudId: "../../etc" } }, ValidationError],
    ["estado desconocido", { estado: "borrador" }, ValidationError],
  ])("%s", async (_name, override, ErrorClass) => {
    const err = await upload(override).catch((e) => e);

    expect(err).toBeInstanceOf(ErrorClass);
    await noSideEffects();
  });

  test("los valores de texto se guardan recortados (sin espacios sobrantes)", async () => {
    await upload({ metadata: { ...validMeta, titulo: "  Cedula  ", entidadAvaladora: " Registraduria " } });
    expect(await Document.findOne().lean()).toMatchObject({ titulo: "Cedula", entidadAvaladora: "Registraduria" });
  });
});

describe("DocumentService.upload() -- bitacora (HT-04) y logs", () => {
  test("la carga exitosa queda en la bitacora con ciudadano, resultado y sin el contenido ni el titulo", async () => {
    const res = await upload();

    const entry = await AuditEntry.findOne({ action: "documento.cargar" }).lean();
    expect(entry).toMatchObject({ actor: OWNER, outcome: "exito", resource: `documento:${res.documentoId}`, resourceOwner: OWNER });
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(JSON.stringify(entry)).not.toContain("Diploma de grado");
  });

  test("los logs no contienen el titulo ni la entidad (datos del ciudadano)", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(l));
    service = build({ publisher: makeFakePublisher(async () => { throw new Error("nack"); }) });

    await upload();

    const dump = lines.join("\n");
    expect(dump).toContain("documento.evento_no_publicado"); // hubo logs que revisar
    expect(dump).not.toContain("Diploma de grado");
    expect(dump).not.toContain("Universidad EAFIT");
  });

  test("si la bitacora falla, la carga ya hecha no se cae", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(l));
    const s = build();
    s.auditLogger = { record: async () => { throw new Error("mongo caido"); } };

    await expect(s.upload({ ciudadanoId: OWNER, file: file(), metadata: validMeta })).resolves.toHaveProperty("documentoId");
    expect(lines.join("\n")).toContain("audit.write_failed");
  });
});

describe("DocumentService.list() -- consulta paginada (HU-08)", () => {
  const OTHER = "6aae9153b7655900026073f2";
  const seed = (ciudadanoId, n, extra = {}) =>
    Document.insertMany(
      Array.from({ length: n }, (_, i) => ({
        ciudadanoId,
        titulo: `Doc ${i + 1}`,
        entidadAvaladora: "Universidad EAFIT",
        fecha: new Date(Date.UTC(2026, 0, i + 1)),
        estado: "temporal",
        storageKey: `ciudadanos/${ciudadanoId}/${i}-${Math.random()}.pdf`,
        mimeType: "application/pdf",
        tamanoBytes: 100,
        sha256: "a".repeat(64),
        ...extra,
      }))
    );

  test("devuelve SOLO los documentos del ciudadano autenticado, nunca los de otro", async () => {
    await seed(OWNER, 3);
    await seed(OTHER, 4);

    const res = await service.list({ ciudadanoId: OWNER });

    expect(res.total).toBe(3);
    expect(res.documentos).toHaveLength(3);
    const ajenos = new Set((await Document.find({ ciudadanoId: OTHER }).lean()).map((d) => String(d._id)));
    expect(res.documentos.some((d) => ajenos.has(d.documentoId))).toBe(false);
  });

  test("cada item trae documentoId, titulo, estado, entidadAvaladora y fechas; NO expone la clave del storage ni la huella", async () => {
    await seed(OWNER, 1);

    const [item] = (await service.list({ ciudadanoId: OWNER })).documentos;

    expect(item).toMatchObject({ titulo: "Doc 1", estado: "temporal", entidadAvaladora: "Universidad EAFIT", mimeType: "application/pdf", tamanoBytes: 100 });
    expect(item.documentoId).toMatch(/^[0-9a-f]{24}$/);
    expect(item.fecha).toBeInstanceOf(Date);
    expect(item.fechaCarga).toBeInstanceOf(Date);
    expect(Object.keys(item).sort()).toEqual(["documentoId", "entidadAvaladora", "estado", "fecha", "fechaCarga", "mimeType", "tamanoBytes", "titulo"]);
  });

  test("por defecto pagina 1 de 10; el sobrante queda en la ultima pagina; totalPages es correcto", async () => {
    await seed(OWNER, 25);

    const p1 = await service.list({ ciudadanoId: OWNER });
    const p3 = await service.list({ ciudadanoId: OWNER, page: "3" });

    expect(p1).toMatchObject({ total: 25, currentPage: 1, pageSize: 10, totalPages: 3 });
    expect(p1.documentos).toHaveLength(10);
    expect(p3.documentos).toHaveLength(5);
  });

  test("las paginas no repiten ni saltan documentos, de la fecha mas reciente a la mas antigua", async () => {
    await seed(OWNER, 7);

    const pages = [1, 2, 3].map((page) => service.list({ ciudadanoId: OWNER, page, pageSize: 3 }));
    const titles = (await Promise.all(pages)).flatMap((p) => p.documentos.map((d) => d.titulo));

    expect(titles).toEqual(["Doc 7", "Doc 6", "Doc 5", "Doc 4", "Doc 3", "Doc 2", "Doc 1"]);
  });

  test("pageSize maximo 100: un valor mayor se limita a 100", async () => {
    await seed(OWNER, 120);

    const res = await service.list({ ciudadanoId: OWNER, pageSize: "500" });

    expect(res.pageSize).toBe(100);
    expect(res.documentos).toHaveLength(100);
    expect(res.totalPages).toBe(2);
  });

  test("carpeta vacia -> documentos:[] y total:0 (no es un error)", async () => {
    await seed(OTHER, 2);

    expect(await service.list({ ciudadanoId: OWNER })).toEqual({ documentos: [], total: 0, currentPage: 1, pageSize: 10, totalPages: 0 });
  });

  test("una pagina fuera de rango devuelve lista vacia con el total real", async () => {
    await seed(OWNER, 3);

    expect(await service.list({ ciudadanoId: OWNER, page: "9" })).toMatchObject({ documentos: [], total: 3, currentPage: 9, totalPages: 1 });
  });

  test("muestra tambien los certificados (el estado se ve tal cual esta guardado)", async () => {
    await seed(OWNER, 1, { estado: "certificado" });
    await seed(OWNER, 1);

    const estados = (await service.list({ ciudadanoId: OWNER })).documentos.map((d) => d.estado).sort();
    expect(estados).toEqual(["certificado", "temporal"]);
  });

  test.each([
    ["page 0", { page: "0" }],
    ["page negativa", { page: "-1" }],
    ["page decimal", { page: "1.5" }],
    ["page con letras", { page: "abc" }],
    ["page en notacion cientifica", { page: "1e3" }],
    ["page enorme", { page: "9".repeat(12) }],
    ["pageSize 0", { pageSize: "0" }],
    ["pageSize negativo", { pageSize: "-5" }],
    ["pageSize no numerico", { pageSize: "diez" }],
    ["page repetida (arreglo)", { page: ["1", "2"] }],
    ["page como objeto (operadores de Mongo)", { page: { $gt: "" } }],
  ])("ValidationError con %s, sin consultar la base", async (_name, params) => {
    const spy = jest.spyOn(Document, "find");
    await expect(service.list({ ciudadanoId: OWNER, ...params })).rejects.toThrow(ValidationError);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("un ciudadanoId ausente o que no es texto (p. ej. un objeto con operadores de Mongo) es ValidationError", async () => {
    for (const ciudadanoId of [undefined, "", { $ne: null }, 42]) {
      await expect(service.list({ ciudadanoId })).rejects.toThrow(ValidationError);
    }
  });
});
