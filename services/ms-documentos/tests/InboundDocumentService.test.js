/**
 * HU-10 (RF-11): recepcion de un documento enviado por una entidad emisora.
 * Incluye los cuatro tests que la propia historia nombra para `InboundDocumentService.receive()`.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const AuditEntry = require("../src/domain/AuditEntry");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
// Se usa el verificador REAL de RNF-07 (vive en ms-identidad, que es donde nacio HT-04) en vez de reescribir aqui su
// criterio: si alguien cambia la regla de "acceso fuera de politica", este test tiene que enterarse. Es una
// dependencia de PRUEBA sobre un archivo sin imports propios; el codigo de produccion de los dos servicios sigue
// sin conocerse entre si.
const AuditQueryService = require("../../ms-identidad/src/application/AuditQueryService");
const logger = require("../src/tracing/logger");
const { DocumentService, ValidationError, UnsupportedMediaTypeError, PayloadTooLargeError, QuotaExceededError } = require("../src/application/DocumentService");
const { InboundDocumentService, DestinatarioNoEncontradoError, EnvioConflictError } = require("../src/application/InboundDocumentService");
const { makeCitizenRegisteredHandler } = require("../src/interfaces/eventHandlers");
const { pdf, makeFakeStorage, makeFakePublisher, validMeta } = require("./helpers");

const ANA = "665f1c04c9de9c4c34f6b52a";
const BETO = "665f1c04c9de9c4c34f6b52b";
const DIR_ANA = "1000000001-3f9c2ab7@carpetacolombia.co";
const DIR_BETO = "1000000002-7ab3c9f2@carpetacolombia.co";
const EAFIT = "6aae9153b7655900026073f1";
const OTRA_ENTIDAD = "6aae9153b7655900026073f2";
const ENVIO = "envio-2026-0001-abcdef";
const QUOTA = 5;
const MAX_CIUDADANO = 10_000;
const MAX_INBOUND = 60_000; // el limite propio de la recepcion institucional, mas alto que el del ciudadano

let mongoServer;
let storage;
let publisher;
let documentService;
let inbound;

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
beforeEach(async () => {
  // dropDatabase() borra los indices, y de ellos dependen la cuota atomica y la idempotencia del envio.
  await Promise.all([Folder.createIndexes(), Document.createIndexes()]);
  storage = makeFakeStorage();
  publisher = makeFakePublisher();
  const folderRepository = new FolderRepository();
  const documentRepository = new DocumentRepository();
  documentService = new DocumentService({
    documentRepository,
    folderRepository,
    storage,
    eventPublisher: publisher,
    auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
    quota: QUOTA,
    maxUploadBytes: MAX_CIUDADANO,
    downloadTtlSeconds: 3600,
    eventPublishTimeoutMs: 500,
    now: () => new Date("2026-09-23T10:00:00Z"),
  });
  inbound = new InboundDocumentService({ documentService, documentRepository, folderRepository, maxInboundBytes: MAX_INBOUND });

  // Ana y Beto ya estan registrados: sus carpetas llegaron por el evento ciudadano.registrado (HU-01, paso 7).
  const handler = makeCitizenRegisteredHandler({ folderRepository });
  await handler({ ciudadanoId: ANA, direccionUnica: DIR_ANA });
  await handler({ ciudadanoId: BETO, direccionUnica: DIR_BETO });
});

const file = (size = 300) => ({ buffer: pdf(size), mimetype: "application/pdf" });
const emisor = { id: EAFIT, verificada: true };
const recibir = (extra = {}) => inbound.receive({ destinatario: DIR_ANA, envioId: ENVIO, emisor, file: file(), metadata: validMeta, ...extra });

describe("receive() resuelve al ciudadano por su direccion unica", () => {
  test("entrega el documento en la carpeta del destinatario y devuelve su id", async () => {
    const res = await recibir();

    expect(res).toMatchObject({ ciudadanoId: ANA, duplicado: false });
    expect(res.documentoId).toMatch(/^[0-9a-f]{24}$/);
    const doc = await Document.findById(res.documentoId).lean();
    expect(doc.ciudadanoId).toBe(ANA);
  });

  test("la direccion elige la carpeta: el mismo envio a Beto llega a Beto, no a Ana", async () => {
    await recibir({ destinatario: DIR_BETO, envioId: "envio-para-beto-0001" });

    expect((await Document.findOne({}).lean()).ciudadanoId).toBe(BETO);
  });

  test("no distingue mayusculas ni espacios en la direccion", async () => {
    const res = await recibir({ destinatario: `  ${DIR_ANA.toUpperCase()} ` });

    expect(res.ciudadanoId).toBe(ANA);
  });

  test("el ciudadanoId NUNCA se toma de la peticion: enviarlo no cambia el destinatario", async () => {
    const res = await inbound.receive({ destinatario: DIR_ANA, envioId: ENVIO, emisor, file: file(), metadata: validMeta, ciudadanoId: BETO });

    expect(res.ciudadanoId).toBe(ANA);
    expect((await Document.findOne({}).lean()).ciudadanoId).toBe(ANA);
  });

  test("no devuelve URL prefirmada: la entidad entrega, no gana acceso de lectura a una carpeta ajena", async () => {
    const res = await recibir();

    expect(res).not.toHaveProperty("url");
  });
});

describe("receive() persiste directo en estado certificado", () => {
  test("el documento nace `certificado`, con la procedencia de la entidad y sin pasar por temporal", async () => {
    const { documentoId } = await recibir();

    expect(await Document.findById(documentoId).lean()).toMatchObject({
      estado: "certificado",
      origen: "entidad",
      emisorInstitutionId: EAFIT,
      envioId: ENVIO,
      ciudadanoId: ANA,
    });
  });

  test("guarda solo la clave del objeto y la huella, nunca el binario", async () => {
    const { documentoId } = await recibir();

    const doc = await Document.findById(documentoId).lean();
    expect(doc.storageKey).toMatch(new RegExp(`^ciudadanos/${ANA}/`)); // la clave es del CIUDADANO, no de la entidad
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(doc)).not.toContain("%PDF");
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  test("una carga del ciudadano (HU-03) sigue naciendo temporal y con origen ciudadano", async () => {
    const { documentoId } = await documentService.upload({ ciudadanoId: ANA, file: file(), metadata: validMeta });

    expect(await Document.findById(documentoId).lean()).toMatchObject({ estado: "temporal", origen: "ciudadano", emisorInstitutionId: null, envioId: null });
  });
});

describe("receive() no aplica cuota ni el limite de tamano del ciudadano", () => {
  test("con la cuota del ciudadano LLENA, la entidad igual puede entregar (los certificados no consumen cuota)", async () => {
    for (let i = 0; i < QUOTA; i++) await documentService.upload({ ciudadanoId: ANA, file: file(), metadata: validMeta });
    await expect(documentService.upload({ ciudadanoId: ANA, file: file(), metadata: validMeta })).rejects.toThrow(QuotaExceededError);

    await expect(recibir()).resolves.toMatchObject({ ciudadanoId: ANA });

    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).noCertificados).toBe(QUOTA); // el contador no se movio
  });

  test("acepta un archivo mayor que el maximo del ciudadano, hasta el limite propio de la recepcion", async () => {
    const grande = { buffer: pdf(MAX_CIUDADANO + 5_000), mimetype: "application/pdf" };

    await expect(documentService.upload({ ciudadanoId: ANA, file: grande, metadata: validMeta })).rejects.toThrow(PayloadTooLargeError);
    await expect(recibir({ file: grande })).resolves.toHaveProperty("documentoId");
  });

  test("pero SI hay un limite: por encima del maximo de recepcion se rechaza (413), porque el archivo se procesa en memoria", async () => {
    const enorme = { buffer: pdf(MAX_INBOUND + 1_000), mimetype: "application/pdf" };

    await expect(recibir({ file: enorme })).rejects.toThrow(PayloadTooLargeError);
    expect(await Document.countDocuments()).toBe(0);
    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe("receive() rechaza si la direccion unica no existe", () => {
  test.each([
    ["no registrada", "9999999999-aaaaaaaa@carpetacolombia.co"],
    ["de otro dominio", "alguien@gmail.com"],
    ["sin forma de direccion", "no-es-una-direccion"],
    ["vacia", "   "],
    ["objeto de consulta de Mongo", { $ne: null }],
  ])("%s -> DestinatarioNoEncontradoError, sin subir nada ni crear documento", async (_name, destinatario) => {
    const err = await recibir({ destinatario }).catch((e) => e);

    expect([DestinatarioNoEncontradoError, ValidationError]).toContainEqual(err.constructor);
    expect(await Document.countDocuments()).toBe(0);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test("el mensaje es el mismo para una direccion inexistente y para una mal formada (no se puede sondear quien esta afiliado)", async () => {
    const inexistente = await recibir({ destinatario: "9999999999-aaaaaaaa@carpetacolombia.co" }).catch((e) => e);
    const malFormada = await recibir({ destinatario: "no-es-una-direccion" }).catch((e) => e);

    expect(inexistente.message).toBe(malFormada.message);
  });

  test("una carpeta SIN direccion unica (evento anterior a HU-10) no es alcanzable", async () => {
    await new FolderRepository().ensure("665f1c04c9de9c4c34f6b52c"); // carpeta sin direccion

    await expect(recibir({ destinatario: "" })).rejects.toThrow(ValidationError);
    expect(await Document.countDocuments()).toBe(0);
  });
});

describe("Validacion de la peticion", () => {
  test.each([
    ["sin emisor", { emisor: undefined }],
    ["emisor sin id", { emisor: {} }],
    ["sin envioId", { envioId: undefined }],
    ["envioId demasiado corto", { envioId: "abc" }],
    ["envioId con caracteres raros", { envioId: "envio/../otro" }],
    ["sin destinatario", { destinatario: undefined }],
  ])("%s -> ValidationError y no se toca nada", async (_name, override) => {
    await expect(recibir(override)).rejects.toThrow(ValidationError);
    expect(await Document.countDocuments()).toBe(0);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test.each([
    ["sin archivo", { file: undefined }, ValidationError],
    ["archivo que no es PDF", { file: { buffer: Buffer.from("MZ ejecutable"), mimetype: "application/pdf" } }, UnsupportedMediaTypeError],
    ["tipo declarado que no es PDF", { file: { buffer: pdf(), mimetype: "image/png" } }, UnsupportedMediaTypeError],
    ["sin titulo", { metadata: { ...validMeta, titulo: undefined } }, ValidationError],
    ["sin entidad avaladora", { metadata: { ...validMeta, entidadAvaladora: undefined } }, ValidationError],
    ["fecha invalida", { metadata: { ...validMeta, fecha: "ayer" } }, ValidationError],
  ])("%s -> se aplica la MISMA validacion que en HU-03", async (_name, override, expected) => {
    await expect(recibir(override)).rejects.toThrow(expected);
    expect(await Document.countDocuments()).toBe(0);
  });
});

describe("Idempotencia por (institucion, envioId)", () => {
  test("un reintento identico devuelve el MISMO documento y no crea otro ni vuelve a subir el archivo", async () => {
    const primero = await recibir();

    const reintento = await recibir();

    expect(reintento).toMatchObject({ documentoId: primero.documentoId, ciudadanoId: ANA, duplicado: true });
    expect(await Document.countDocuments()).toBe(1);
    expect(storage.put).toHaveBeenCalledTimes(1); // el segundo ni toco el storage
  });

  test("el mismo envioId con OTRO contenido es conflicto: no se pisa ni se devuelve el anterior en silencio", async () => {
    const primero = await recibir();

    const err = await recibir({ file: file(900) }).catch((e) => e);

    expect(err).toBeInstanceOf(EnvioConflictError);
    expect(err.documentoId).toBe(primero.documentoId);
    expect(await Document.countDocuments()).toBe(1);
  });

  test("el mismo envioId hacia OTRO destinatario tambien es conflicto", async () => {
    await recibir();

    await expect(recibir({ destinatario: DIR_BETO })).rejects.toThrow(EnvioConflictError);
    expect(await Document.countDocuments()).toBe(1);
  });

  test("el envioId es POR institucion: dos entidades distintas pueden usar el mismo sin chocar", async () => {
    await recibir();

    await expect(recibir({ emisor: { id: OTRA_ENTIDAD, verificada: true } })).resolves.toMatchObject({ duplicado: false });
    expect(await Document.countDocuments()).toBe(2);
  });

  test("la misma entidad puede entregar varios documentos distintos con envioId distintos", async () => {
    await recibir();
    await recibir({ envioId: "envio-2026-0002-abcdef", file: file(500) });

    expect(await Document.countDocuments({ ciudadanoId: ANA })).toBe(2);
  });

  test("CONCURRENCIA: 6 reintentos simultaneos del mismo envio -> UN solo documento", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => recibir().catch((e) => e)));

    const ok = results.filter((r) => r.documentoId);
    expect(ok).toHaveLength(6); // todos reciben respuesta util, no errores
    expect(new Set(ok.map((r) => r.documentoId)).size).toBe(1); // y es el mismo documento
    expect(await Document.countDocuments()).toBe(1);
  });

  test("la carga del ciudadano (HU-03) no lleva envioId y varias no chocan entre si (indice parcial)", async () => {
    await documentService.upload({ ciudadanoId: ANA, file: file(), metadata: validMeta });
    await documentService.upload({ ciudadanoId: ANA, file: file(), metadata: validMeta });

    expect(await Document.countDocuments({ envioId: null })).toBe(2);
  });
});

describe("Bitacora (HT-04, RNF-07): la entidad actua sobre una carpeta ajena, de forma delegada", () => {
  test("la entrega queda con actorType entidad, el ciudadano como dueno y delegated:true", async () => {
    const { documentoId } = await recibir();

    const entry = await AuditEntry.findOne({ action: "documento.recibir" }).lean();
    expect(entry).toMatchObject({
      actor: EAFIT,
      actorType: "entidad",
      action: "documento.recibir",
      resource: `documento:${documentoId}`,
      resourceOwner: ANA,
      delegated: true,
      outcome: "exito",
    });
  });

  test("y NO se cuenta como acceso fuera de politica (RNF-07)", async () => {
    await recibir();

    const auditoria = await new AuditQueryService({ auditRepository: new AuditRepository() }).verifyNoOutOfPolicyAccess();

    expect(auditoria.compliant).toBe(true);
    expect(auditoria.violations).toHaveLength(0);
  });

  test("sin `delegated` la misma entrada SI seria una violacion: es la marca lo que la hace legitima", async () => {
    await recibir();
    await new AuditLogger({ auditRepository: new AuditRepository() }).record({
      actor: EAFIT, actorType: "entidad", action: "documento.recibir",
      resource: "documento:otro", resourceOwner: ANA, outcome: "exito", // sin delegated
    });

    const auditoria = await new AuditQueryService({ auditRepository: new AuditRepository() }).verifyNoOutOfPolicyAccess();

    expect(auditoria.compliant).toBe(false);
    expect(auditoria.violations).toHaveLength(1);
  });

  test("la carga del ciudadano sigue auditandose como antes: actor = dueno, sin delegacion", async () => {
    await documentService.upload({ ciudadanoId: ANA, file: file(), metadata: validMeta });

    const entry = await AuditEntry.findOne({ action: "documento.cargar" }).lean();
    expect(entry).toMatchObject({ actor: ANA, actorType: "ciudadano", resourceOwner: ANA, delegated: false });
  });

  test("un fallo del storage queda auditado como fallo de la ENTIDAD sobre la carpeta del ciudadano", async () => {
    storage.failPut = true;

    await recibir().catch(() => {});

    const entry = await AuditEntry.findOne({ action: "documento.recibir" }).lean();
    expect(entry).toMatchObject({ actor: EAFIT, actorType: "entidad", resourceOwner: ANA, delegated: true, outcome: "fallo" });
    expect(await Document.countDocuments()).toBe(0);
  });

  test("los logs no llevan la direccion unica, el titulo ni el contenido", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));

    await recibir();
    await recibir({ destinatario: "9999999999-aaaaaaaa@carpetacolombia.co" }).catch(() => {});

    const dump = lines.join("\n");
    for (const dato of [DIR_ANA, "Diploma de grado", "%PDF"]) expect(dump).not.toContain(dato);
  });
});

describe("Evento documento.cargado: se reutiliza el de HU-03 (AC 5)", () => {
  test("publica el MISMO evento, con el ciudadano destinatario y el estado certificado", async () => {
    const { documentoId } = await recibir();

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [routingKey, payload] = publisher.publish.mock.calls[0];
    expect(routingKey).toBe("documento.cargado");
    expect(payload).toMatchObject({ eventId: documentoId, documentoId, ciudadanoId: ANA, estado: "certificado", titulo: validMeta.titulo, entidadAvaladora: validMeta.entidadAvaladora });
  });

  test("si el broker no confirma, la entrega NO falla: queda pendiente de reconciliar (ADR-04)", async () => {
    publisher = makeFakePublisher(async () => {
      throw new Error("broker caido");
    });
    documentService.eventPublisher = publisher;

    const res = await recibir();

    expect(res.documentoId).toBeDefined();
    expect((await Document.findById(res.documentoId).lean()).eventoPublicado).toBe(false);
  });

  test("un reintento idempotente no publica un segundo evento (el ciudadano no recibe dos avisos)", async () => {
    await recibir();
    await recibir();

    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });
});
