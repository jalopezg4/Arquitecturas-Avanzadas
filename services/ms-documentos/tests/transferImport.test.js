/**
 * HU-05c, ola 5: ms-documentos del lado DESTINO -- importa los documentos de un ciudadano que llega desde otro
 * operador. El "otro operador" es un servidor HTTP real en un puerto efimero (por eso se permite localhost aqui).
 */
const http = require("http");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { RemoteFileFetcher } = require("../src/infrastructure/RemoteFileFetcher");
const { TransferImportService } = require("../src/application/TransferImportService");
const { makeTransferImportHandlers } = require("../src/interfaces/eventHandlers");
const { DocumentAuthenticationService, DocumentoNoDisponibleError } = require("../src/application/DocumentAuthenticationService");
const { pdf, makeFakeStorage, makeFakePublisher } = require("./helpers");

const T1 = "6ab68fddb64d2aa730b41501";
const NUEVO = "6ab68fddb64d2aa730b415f0";
const DIR = "1000000001-3f9c2ab7@carpetacolombia.co";
const PDF1 = pdf(300);
const PDF2 = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 0x41)]);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let mongoServer;
let origin;
let base;
let routes;
let storage;
let publisher;
let handlers;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  origin = http.createServer((req, res) => {
    const handler = routes[req.url];
    if (!handler) {
      res.statusCode = 404;
      return res.end();
    }
    return handler(req, res);
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${origin.address().port}`;
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
  await new Promise((r) => origin.close(r));
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});
beforeEach(async () => {
  await Promise.all([Document.createIndexes(), Folder.createIndexes()]);
  routes = {
    "/a.pdf": (_req, res) => res.end(PDF1),
    "/b.pdf": (_req, res) => res.end(PDF2),
    "/exe": (_req, res) => res.end(Buffer.from("MZ\x90\x00 no soy un pdf")),
    "/caido": (_req, res) => {
      res.statusCode = 503;
      res.end();
    },
    "/grande": (_req, res) => res.end(Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(5000)])),
    "/redirige": (_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", `${base}/a.pdf`);
      res.end();
    },
  };
  storage = makeFakeStorage();
  publisher = makeFakePublisher();
  handlers = makeTransferImportHandlers({
    transferImportService: new TransferImportService({
      documentRepository: new DocumentRepository(),
      folderRepository: new FolderRepository(),
      storage,
      fetcher: new RemoteFileFetcher({ timeoutMs: 2000, maxBytes: 4096, allowPrivate: true }),
      eventPublisher: publisher,
      eventPublishTimeoutMs: 200,
    }),
  });
});

const orden = (documentos, extra = {}) => ({ transferenciaId: T1, ciudadanoId: NUEVO, documento: 1000000001, direccionUnica: DIR, documentos, ...extra });
const respuestas = () => publisher.publish.mock.calls.filter(([rk]) => rk === "transferencia.documentos_importados").map(([, p]) => p);
const dosDocs = () => [
  { clave: "URL1", url: `${base}/a.pdf`, titulo: "Diploma", entidadAvaladora: "EAFIT", fecha: "2026-03-15T00:00:00.000Z", estado: "certificado", sha256: sha(PDF1) },
  { clave: "URL2", url: `${base}/b.pdf`, titulo: "Acta" },
];

describe("transferencia.importar_documentos", () => {
  test("descarga cada documento, lo guarda en NUESTRO storage y lo crea con sus metadatos en la carpeta nueva", async () => {
    await handlers.importar(orden(dosDocs()));

    const docs = await Document.find({ ciudadanoId: NUEVO }).sort({ claveTransferencia: 1 }).lean();
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ titulo: "Diploma", entidadAvaladora: "EAFIT", estado: "certificado", origen: "transferencia", sha256: sha(PDF1), mimeType: "application/pdf" });
    expect(docs[1]).toMatchObject({ titulo: "Acta", entidadAvaladora: "No informada", estado: "temporal" }); // sin metadatos: temporal
    expect(storage.objects.size).toBe(2);
    expect([...storage.objects.values()][0].body.equals(PDF1)).toBe(true);
    // La carpeta nace con la direccion unica y la cedula; el temporal ocupa cupo.
    expect(await Folder.findOne({ ciudadanoId: NUEVO }).lean()).toMatchObject({ direccionUnica: DIR, documento: 1000000001, noCertificados: 1 });
    expect(respuestas()).toEqual([{ transferenciaId: T1, ciudadanoId: NUEVO, ok: true, importados: 2 }]);
  });

  test("una reentrega de la misma orden no duplica documentos ni vuelve a subir archivos", async () => {
    await handlers.importar(orden(dosDocs()));
    await handlers.importar(orden(dosDocs()));

    expect(await Document.countDocuments({ ciudadanoId: NUEVO })).toBe(2);
    expect(storage.put).toHaveBeenCalledTimes(2);
    expect((await Folder.findOne({ ciudadanoId: NUEVO }).lean()).noCertificados).toBe(1);
  });

  test("un ciudadano sin documentos tambien se importa (carpeta vacia, ok)", async () => {
    await handlers.importar(orden([]));
    expect(respuestas()[0]).toMatchObject({ ok: true, importados: 0 });
    expect(await Folder.countDocuments({ ciudadanoId: NUEVO })).toBe(1);
  });

  test.each([
    ["un archivo que no es PDF/imagen (firma real)", "/exe", /tipo de archivo/],
    ["un archivo mayor al tope", "/grande", /supera/],
    ["una redireccion (no se siguen)", "/redirige", /302/],
    ["una URL que no existe", "/no-existe", /404/],
  ])("TODO o NADA: %s -> deshace lo importado y responde ok:false", async (_caso, path, motivo) => {
    await handlers.importar(orden([dosDocs()[0], { clave: "URL2", url: `${base}${path}` }]));

    expect(respuestas()[0]).toMatchObject({ ok: false });
    expect(respuestas()[0].motivo).toMatch(motivo);
    expect(await Document.countDocuments({ ciudadanoId: NUEVO })).toBe(0);
    expect(storage.objects.size).toBe(0);
  });

  test("la huella declarada no coincide -> ok:false (el documento se altero en el camino)", async () => {
    await handlers.importar(orden([{ ...dosDocs()[0], sha256: "0".repeat(64) }]));
    expect(respuestas()[0]).toMatchObject({ ok: false });
    expect(respuestas()[0].motivo).toMatch(/huella/);
  });

  test("el origen caido (5xx) es transitorio: la orden se reintenta y lo ya descargado se conserva", async () => {
    await expect(handlers.importar(orden([dosDocs()[0], { clave: "URL2", url: `${base}/caido` }]))).rejects.toThrow(/503/);
    expect(await Document.countDocuments({ ciudadanoId: NUEVO })).toBe(1);

    routes["/caido"] = (_req, res) => res.end(PDF2);
    await handlers.importar(orden([dosDocs()[0], { clave: "URL2", url: `${base}/caido` }]));

    expect(await Document.countDocuments({ ciudadanoId: NUEVO })).toBe(2);
    expect(storage.put).toHaveBeenCalledTimes(2);
  });

  // Revision del PR #90: los temporales traidos en la entrega que se corto tambien ocupan cupo.
  test("tras un corte a mitad, el reintento cuenta el cupo de TODOS los temporales importados (una sola vez)", async () => {
    const docs = [{ clave: "URL2", url: `${base}/b.pdf`, titulo: "Acta" }, { clave: "URL3", url: `${base}/caido`, titulo: "Recibo" }];
    await expect(handlers.importar(orden(docs))).rejects.toThrow(/503/);

    routes["/caido"] = (_req, res) => res.end(PDF2);
    await handlers.importar(orden(docs));
    await handlers.importar(orden(docs)); // reentrega

    const folder = await Folder.findOne({ ciudadanoId: NUEVO }).lean();
    expect(folder.noCertificados).toBe(2);
    expect(folder.cupos).toHaveLength(2);
  });

  test.each([
    ["ciudadanoId que no es ObjectId", { ciudadanoId: "abc" }],
    ["documentos no es arreglo", { documentos: "x" }],
    ["clave invalida", { documentos: [{ clave: "../x", url: "https://a.co/x" }] }],
  ])("orden mal formada (%s) -> cola de fallidos", async (_c, extra) => {
    await expect(handlers.importar(orden(dosDocs(), extra))).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("transferencia.revertir_importacion", () => {
  test("borra los objetos y documentos de esa transferencia y la carpeta vacia; repetirlo no hace nada", async () => {
    await handlers.importar(orden(dosDocs()));

    await handlers.revertir({ transferenciaId: T1, ciudadanoId: NUEVO });
    await handlers.revertir({ transferenciaId: T1, ciudadanoId: NUEVO });

    expect(await Document.countDocuments({ ciudadanoId: NUEVO })).toBe(0);
    expect(storage.objects.size).toBe(0);
    expect(await Folder.countDocuments({ ciudadanoId: NUEVO })).toBe(0);
  });
});

describe("RemoteFileFetcher (SSRF)", () => {
  test("sin permiso explicito rechaza localhost e IPs privadas, antes de conectarse", async () => {
    const fetcher = new RemoteFileFetcher({ allowPrivate: false });
    await expect(fetcher.fetch(`${base}/a.pdf`)).rejects.toThrow(/local o privada/);
    await expect(fetcher.fetch("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/local o privada/);
    await expect(fetcher.fetch("file:///etc/passwd")).rejects.toThrow(/esquema/);
  });
});

describe("Un escaneo importado no se puede autenticar (HU-04 solo firma PDF)", () => {
  test("pedir autenticar una imagen importada -> DocumentoNoDisponibleError (400) sin cambiar su estado", async () => {
    await Folder.create({ ciudadanoId: NUEVO, documento: 1000000001 });
    const img = await Document.create({ ciudadanoId: NUEVO, titulo: "Escaneo", entidadAvaladora: "X", fecha: new Date(), storageKey: `ciudadanos/${NUEVO}/x.png`, mimeType: "image/png", tamanoBytes: 10, sha256: "a".repeat(64), origen: "transferencia" });
    const service = new DocumentAuthenticationService({ documentRepository: new DocumentRepository(), folderRepository: new FolderRepository(), eventPublisher: publisher });

    await expect(service.request({ ciudadanoId: NUEVO, documentoId: String(img._id) })).rejects.toBeInstanceOf(DocumentoNoDisponibleError);
    expect((await Document.findById(img._id).lean()).estado).toBe("temporal");
  });
});

describe("RemoteFileFetcher: DNS rebinding de extremo a extremo (servidor HTTP real)", () => {
  const HOST = "operador-falso.example.co";
  // Resolvedor falso: un nombre publico que "resuelve" a loopback, como haria un atacante que controla su DNS.
  const resolve = (hostname, options, callback) => (hostname === HOST ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(new Error("ENOTFOUND")));

  test("con la politica relajada (solo local) el nombre llega: la descarga usa nuestro lookup", async () => {
    const fetcher = new RemoteFileFetcher({ allowPrivate: true, resolve, timeoutMs: 2000, maxBytes: 4096 });
    const url = `http://${HOST}:${new URL(base).port}/a.pdf`;
    await expect(fetcher.fetch(url)).resolves.toMatchObject({ buffer: PDF1 });
  });

  test("con la politica activa se bloquea al conectar, aunque antes se haya conectado al mismo host (sin reutilizar sockets)", async () => {
    const url = `http://${HOST}:${new URL(base).port}/a.pdf`;
    await new RemoteFileFetcher({ allowPrivate: true, resolve, timeoutMs: 2000, maxBytes: 4096 }).fetch(url);

    await expect(new RemoteFileFetcher({ allowPrivate: false, resolve, timeoutMs: 2000 }).fetch(url)).rejects.toThrow(/local o privada/);
  });
});

