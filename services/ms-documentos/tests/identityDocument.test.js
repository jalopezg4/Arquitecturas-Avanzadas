const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const AuditEntry = require("../src/domain/AuditEntry");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const { DocumentService } = require("../src/application/DocumentService");
const { IdentityDocumentService } = require("../src/application/IdentityDocumentService");
const { SimulatedRegistraduriaDocumentClient, renderPdf } = require("../src/infrastructure/RegistraduriaDocumentClient");
const { makeCitizenRegisteredHandler } = require("../src/interfaces/eventHandlers");
const logger = require("../src/tracing/logger");
const { makeFakeStorage, makeFakePublisher } = require("./helpers");

const ANA = "6aae9153b7655900026073f1";
const evento = (extra = {}) => ({ ciudadanoId: ANA, documento: 1914725310, nombre: "Ana Gomez", direccionUnica: "1914725310-abcd1234@carpetacolombia.co", origen: "registro", ...extra });

let mongoServer;
let storage;
let publisher;
let registraduria;
let handler;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
beforeEach(async () => {
  await Promise.all([Folder.createIndexes(), Document.createIndexes(), AuditEntry.createIndexes()]); // dropDatabase() borra los indices unicos
  storage = makeFakeStorage();
  publisher = makeFakePublisher();
  registraduria = new SimulatedRegistraduriaDocumentClient({ now: () => new Date("2026-10-01T12:00:00Z") });
  jest.spyOn(registraduria, "signedIdCard");
  const documentRepository = new DocumentRepository();
  const folderRepository = new FolderRepository();
  const documentService = new DocumentService({
    documentRepository,
    folderRepository,
    storage,
    eventPublisher: publisher,
    auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
    quota: 5,
    maxUploadBytes: 1024 * 1024,
    downloadTtlSeconds: 3600,
    eventPublishTimeoutMs: 300,
  });
  handler = makeCitizenRegisteredHandler({ folderRepository, identityDocumentService: new IdentityDocumentService({ documentRepository, documentService, registraduria }) });
});
afterEach(async () => {
  jest.restoreAllMocks();
  logger.resetSink();
  await mongoose.connection.dropDatabase();
});

describe("ciudadano.registrado guarda la cedula firmada por la Registraduria (HU-01, paso 13)", () => {
  test("crea la carpeta y un documento CERTIFICADO de origen registraduria, con su archivo en el storage", async () => {
    await handler(evento());

    const docs = await Document.find({ ciudadanoId: ANA }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ estado: "certificado", origen: "registraduria", titulo: "Cedula de ciudadania", entidadAvaladora: "Registraduria Nacional del Estado Civil", mimeType: "application/pdf" });
    expect(docs[0].fecha.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    const stored = storage.objects.get(docs[0].storageKey);
    expect(stored.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(stored.body.toString("latin1")).toContain("1914725310");
  });

  test("NO consume cuota (RNF-04): el ciudadano conserva sus 5 cupos de no certificados", async () => {
    await handler(evento());
    const folder = await Folder.findOne({ ciudadanoId: ANA }).lean();
    expect(folder.noCertificados).toBe(0);
  });

  test("idempotente: el mismo evento repetido deja UNA sola cedula y no vuelve a pedirla", async () => {
    await handler(evento());
    await handler(evento());

    expect(await Document.countDocuments({ ciudadanoId: ANA, origen: "registraduria" })).toBe(1);
    expect(registraduria.signedIdCard).toHaveBeenCalledTimes(1);
  });

  test("CONCURRENCIA: 5 entregas simultaneas del evento -> una sola cedula (indice unico) y ningun error", async () => {
    await Folder.create({ ciudadanoId: ANA, noCertificados: 0, cupos: [] });

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => handler(evento())));

    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await Document.countDocuments({ ciudadanoId: ANA, origen: "registraduria" })).toBe(1);
    expect(storage.objects.size).toBe(1); // las cargas perdedoras borraron su archivo (compensacion de upload)
  });

  test("un ciudadano que llega por TRANSFERENCIA no recibe cedula nueva (trae sus documentos del origen)", async () => {
    await handler(evento({ origen: "transferencia" }));

    expect(await Folder.countDocuments({ ciudadanoId: ANA })).toBe(1);
    expect(await Document.countDocuments()).toBe(0);
    expect(registraduria.signedIdCard).not.toHaveBeenCalled();
  });

  test.each([
    ["sin origen (eventos anteriores)", { origen: undefined }],
    ["sin documento", { documento: undefined }],
    ["sin nombre", { nombre: undefined }],
    ["nombre vacio", { nombre: "   " }],
  ])("%s: crea la carpeta pero no pide la cedula", async (_name, extra) => {
    await handler(evento(extra));
    expect(await Folder.countDocuments({ ciudadanoId: ANA })).toBe(1);
    expect(registraduria.signedIdCard).not.toHaveBeenCalled();
  });

  test("si la Registraduria no responde, el error sube (el consumidor reintenta) y la carpeta ya queda creada", async () => {
    registraduria.signedIdCard.mockRejectedValueOnce(new Error("timeout"));

    await expect(handler(evento())).rejects.toThrow("timeout");
    expect(await Folder.countDocuments({ ciudadanoId: ANA })).toBe(1);

    await handler(evento()); // el reintento la guarda
    expect(await Document.countDocuments({ origen: "registraduria" })).toBe(1);
  });

  test("queda en la bitacora como accion del sistema (Registraduria) sobre la carpeta del ciudadano", async () => {
    await handler(evento());
    const entry = await AuditEntry.findOne({ action: "documento.recibir_cedula" }).lean();
    expect(entry).toMatchObject({ actor: "registraduria", actorType: "sistema", resourceOwner: ANA, outcome: "exito" });
  });
});

describe("PDF de la cedula simulada", () => {
  test("es un PDF con estructura valida: xref con desplazamientos exactos de cada objeto", () => {
    const pdf = renderPdf(["hola"]).toString("latin1");
    const xrefAt = Number(pdf.match(/startxref\n(\d+)/)[1]);
    expect(pdf.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((off, i) => expect(pdf.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  test("escapa ( ) \\ y quita caracteres de control: un nombre no puede romper ni inyectar contenido en el PDF", () => {
    const pdf = renderPdf(["Ana (x) \\ y\r\n) Tj (inyectado"]).toString("latin1");
    expect(pdf).toContain("(Ana \\(x\\) \\\\ y  \\) Tj \\(inyectado) Tj T*");
  });

  test("dice que es una simulacion sin validez oficial", async () => {
    const { buffer } = await new SimulatedRegistraduriaDocumentClient().signedIdCard({ documento: 1, nombre: "A" });
    expect(buffer.toString("latin1")).toMatch(/SIMULADA[\s\S]*No tiene validez oficial/);
  });
});
