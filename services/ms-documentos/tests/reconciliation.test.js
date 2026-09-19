const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { EventEmitter } = require("events");

const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const EventPublisher = require("../src/infrastructure/EventPublisher");
const EventReconciler = require("../src/application/EventReconciler");
const { documentoCargadoPayload } = require("../src/application/events");
const { makeCitizenRegisteredHandler } = require("../src/interfaces/eventHandlers");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { DocumentService } = require("../src/application/DocumentService");
const logger = require("../src/tracing/logger");
const { pdf, makeFakeStorage, makeFakePublisher, validMeta } = require("./helpers");

const OWNER = "6aae9153b7655900026073f1";
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
beforeEach(async () => {
  await Promise.all([Folder.createIndexes(), Document.createIndexes()]); // dropDatabase() borra los indices unicos
});
afterEach(async () => {
  logger.resetSink();
  await mongoose.connection.dropDatabase();
});

const NOW = new Date("2026-09-20T12:00:00Z");
const seed = (extra = {}) =>
  Document.create({
    ciudadanoId: OWNER,
    titulo: "Diploma",
    entidadAvaladora: "EAFIT",
    fecha: new Date("2026-03-15"),
    storageKey: `ciudadanos/${OWNER}/${Math.random()}.pdf`,
    mimeType: "application/pdf",
    tamanoBytes: 100,
    sha256: "a".repeat(64),
    eventoPublicado: false,
    ...extra,
  });
const backdate = (doc, ms) => Document.collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(NOW.getTime() - ms) } });

function build(publisher, overrides = {}) {
  return new EventReconciler({ documentRepository: new DocumentRepository(), eventPublisher: publisher, minAgeMs: 60000, publishTimeoutMs: 200, now: () => NOW, ...overrides });
}

describe("EventReconciler: reenvia los documento.cargado que no se publicaron", () => {
  test("reenvia el evento pendiente, con el MISMO contenido, y marca el documento como publicado", async () => {
    const doc = await seed();
    await backdate(doc, 5 * 60000);
    const publisher = makeFakePublisher();

    const res = await build(publisher).reconcileOnce();

    expect(res).toEqual({ republished: 1, failed: 0 });
    const [key, payload] = publisher.publish.mock.calls[0];
    expect(key).toBe("documento.cargado");
    expect(payload).toMatchObject({ documentoId: String(doc._id), ciudadanoId: OWNER, titulo: "Diploma", estado: "temporal" });
    expect((await Document.findById(doc._id)).eventoPublicado).toBe(true);
  });

  test("el eventId es DETERMINISTICO (el id del documento): un duplicado no genera un segundo correo", async () => {
    const doc = await seed();
    const stored = await Document.findById(doc._id).lean();

    expect(documentoCargadoPayload(stored).eventId).toBe(String(doc._id));
    expect(documentoCargadoPayload(stored)).toEqual(documentoCargadoPayload(stored));
  });

  test("no toca los ya publicados", async () => {
    const doc = await seed({ eventoPublicado: true });
    await backdate(doc, 5 * 60000);
    const publisher = makeFakePublisher();

    expect(await build(publisher).reconcileOnce()).toEqual({ republished: 0, failed: 0 });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  test("no toca uno recien cargado (su publicacion original puede seguir en curso)", async () => {
    const doc = await seed();
    await backdate(doc, 10000); // 10 s < 60 s
    const publisher = makeFakePublisher();

    expect(await build(publisher).reconcileOnce()).toEqual({ republished: 0, failed: 0 });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  test("si el broker sigue caido, el documento sigue pendiente y se reintenta en la siguiente pasada", async () => {
    const doc = await seed();
    await backdate(doc, 5 * 60000);
    const publisher = makeFakePublisher(async () => {
      throw new Error("broker caido");
    });

    expect(await build(publisher).reconcileOnce()).toEqual({ republished: 0, failed: 1 });
    expect((await Document.findById(doc._id)).eventoPublicado).toBe(false);

    publisher.publish.mockImplementation(async () => {});
    expect(await build(publisher).reconcileOnce()).toEqual({ republished: 1, failed: 0 });
    expect((await Document.findById(doc._id)).eventoPublicado).toBe(true);
  });

  test("un broker que no confirma NO cuelga la pasada (timeout) y el documento queda pendiente", async () => {
    const doc = await seed();
    await backdate(doc, 5 * 60000);
    const publisher = makeFakePublisher(() => new Promise(() => {}));

    expect(await build(publisher, { publishTimeoutMs: 50 }).reconcileOnce()).toEqual({ republished: 0, failed: 1 });
    expect((await Document.findById(doc._id)).eventoPublicado).toBe(false);
  });

  test("un documento que falla no impide reenviar los demas", async () => {
    const a = await seed({ titulo: "A" });
    const b = await seed({ titulo: "B" });
    await backdate(a, 5 * 60000);
    await backdate(b, 4 * 60000);
    const publisher = makeFakePublisher(async (_k, payload) => {
      if (payload.titulo === "A") throw new Error("nack");
    });

    expect(await build(publisher).reconcileOnce()).toEqual({ republished: 1, failed: 1 });
    expect((await Document.findById(b._id)).eventoPublicado).toBe(true);
  });

  test("procesa en lotes acotados (batchSize)", async () => {
    for (let i = 0; i < 5; i++) await backdate(await seed(), 5 * 60000);
    const publisher = makeFakePublisher();

    expect((await build(publisher, { batchSize: 2 }).reconcileOnce()).republished).toBe(2);
    expect(await Document.countDocuments({ eventoPublicado: false })).toBe(3);
  });

  test("extremo a extremo: una carga con el broker caido queda pendiente y luego se reenvia con el mismo evento", async () => {
    const failing = makeFakePublisher(async () => {
      throw new Error("broker caido");
    });
    const service = new DocumentService({
      documentRepository: new DocumentRepository(),
      folderRepository: new FolderRepository(),
      storage: makeFakeStorage(),
      eventPublisher: failing,
      quota: 5,
      maxUploadBytes: 1024 * 1024,
      downloadTtlSeconds: 3600,
      eventPublishTimeoutMs: 200,
      now: () => NOW,
    });
    const { documentoId } = await service.upload({ ciudadanoId: OWNER, file: { buffer: pdf(), mimetype: "application/pdf" }, metadata: validMeta });
    expect((await Document.findById(documentoId)).eventoPublicado).toBe(false);
    const original = failing.publish.mock.calls[0][1];
    await backdate({ _id: documentoId }, 5 * 60000);

    const healthy = makeFakePublisher();
    await build(healthy).reconcileOnce();

    expect(healthy.publish.mock.calls[0][1]).toEqual(original); // exactamente el mismo mensaje
    expect((await Document.findById(documentoId)).eventoPublicado).toBe(true);
  });

  test("start() repite la pasada, no se solapa consigo misma y stop() la detiene", async () => {
    jest.useFakeTimers();
    try {
      const r = build(makeFakePublisher());
      let running = 0;
      let peak = 0;
      let calls = 0;
      r.reconcileOnce = async () => {
        calls++;
        peak = Math.max(peak, ++running);
        await new Promise((res) => setTimeout(res, 250));
        running--;
      };

      r.start(100);
      await jest.advanceTimersByTimeAsync(1000);
      expect(peak).toBe(1);
      expect(calls).toBeGreaterThan(1);

      r.stop();
      const seen = calls;
      await jest.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(seen);
    } finally {
      jest.useRealTimers();
    }
  });

  test("un error inesperado en la pasada se registra y NO tumba el proceso ni detiene el ciclo", async () => {
    jest.useFakeTimers();
    try {
      const r = build(makeFakePublisher());
      let calls = 0;
      r.reconcileOnce = async () => {
        calls++;
        throw new Error("mongo caido");
      };
      r.start(100);
      await jest.advanceTimersByTimeAsync(450);
      r.stop();
      expect(calls).toBeGreaterThan(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("ciudadano.registrado -> carpeta (HU-01, paso 7)", () => {
  const handler = () => makeCitizenRegisteredHandler({ folderRepository: new FolderRepository() });

  test("crea la carpeta del ciudadano con cupo en cero", async () => {
    await handler()({ ciudadanoId: OWNER, documento: 1, direccionUnica: "x@y" });

    expect(await Folder.findOne({ ciudadanoId: OWNER }).lean()).toMatchObject({ noCertificados: 0 });
  });

  test("es idempotente: el mismo evento dos veces (o 8 a la vez) deja UNA carpeta", async () => {
    const h = handler();
    await Promise.all(Array.from({ length: 8 }, () => h({ ciudadanoId: OWNER })));
    await h({ ciudadanoId: OWNER });

    expect(await Folder.countDocuments()).toBe(1);
  });

  test("no pisa el contador de una carpeta que ya tiene documentos", async () => {
    await Folder.create({ ciudadanoId: OWNER, noCertificados: 3 });

    await handler()({ ciudadanoId: OWNER });

    expect((await Folder.findOne({ ciudadanoId: OWNER })).noCertificados).toBe(3);
  });

  test.each([[undefined], [null], [{}], [{ ciudadanoId: 42 }], [{ ciudadanoId: "" }], [{ ciudadanoId: { $ne: null } }], [{ ciudadanoId: "a/b" }], [{ ciudadanoId: "x".repeat(65) }]])("un mensaje invalido (%j) es un error PERMANENTE (a fallidos, sin reintentos) y no crea nada", async (payload) => {
    await expect(handler()(payload)).rejects.toThrow(PermanentError);
    expect(await Folder.countDocuments()).toBe(0);
  });

  test("un fallo de Mongo NO es permanente: se reintenta", async () => {
    const h = makeCitizenRegisteredHandler({ folderRepository: { ensure: jest.fn(async () => { throw new Error("mongo caido"); }) } });
    const err = await h({ ciudadanoId: OWNER }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentError);
  });
});

describe("EventPublisher: se recupera cuando RabbitMQ se reinicia", () => {
  /** Broker falso: conexiones/canales con eventos, y un modo "caido" que rechaza conectar. */
  function makeBroker() {
    const broker = { down: false, connects: 0, published: [], conns: [] };
    broker.connect = jest.fn(async () => {
      if (broker.down) throw new Error("ECONNREFUSED");
      broker.connects++;
      const conn = new EventEmitter();
      const channel = new EventEmitter();
      channel.assertExchange = async () => {};
      channel.assertQueue = async () => {};
      channel.bindQueue = async () => {};
      channel.publish = (ex, key, buf, _opts, cb) => {
        if (channel.closed) throw new Error("Channel closed");
        broker.published.push({ key, body: JSON.parse(buf.toString()) });
        cb(null);
      };
      conn.createConfirmChannel = async () => channel;
      conn.kill = () => {
        channel.closed = true;
        conn.emit("close");
      };
      broker.conns.push(conn);
      return conn;
    });
    return broker;
  }

  test("tras reiniciarse el broker, la siguiente publicacion reconecta sola (antes fallaba para siempre)", async () => {
    const broker = makeBroker();
    const pub = new EventPublisher("amqp://x", { connect: broker.connect });
    await pub.publish("documento.cargado", { n: 1 });

    broker.conns[0].kill(); // el broker se cae
    await pub.publish("documento.cargado", { n: 2 });

    expect(broker.connects).toBe(2);
    expect(broker.published.map((p) => p.body.n)).toEqual([1, 2]);
  });

  test("con el broker caido publish() rechaza (no cuelga) y cuando vuelve funciona sin reiniciar el servicio", async () => {
    const broker = makeBroker();
    const pub = new EventPublisher("amqp://x", { connect: broker.connect });
    await pub.publish("k", { n: 1 });
    broker.conns[0].kill();
    broker.down = true;

    await expect(pub.publish("k", { n: 2 })).rejects.toThrow("ECONNREFUSED");
    broker.down = false;
    await pub.publish("k", { n: 3 });

    expect(broker.published.map((p) => p.body.n)).toEqual([1, 3]);
  });

  test("publicaciones simultaneas comparten UNA apertura de conexion", async () => {
    const broker = makeBroker();
    const pub = new EventPublisher("amqp://x", { connect: broker.connect });

    await Promise.all(Array.from({ length: 6 }, (_, i) => pub.publish("k", { n: i })));

    expect(broker.connects).toBe(1);
    expect(broker.published).toHaveLength(6);
  });

  test("un evento 'error' de la conexion no tumba el proceso (sin oyente, amqplib lo relanza)", async () => {
    const broker = makeBroker();
    const pub = new EventPublisher("amqp://x", { connect: broker.connect });
    await pub.publish("k", { n: 1 });

    expect(() => broker.conns[0].emit("error", new Error("reset"))).not.toThrow();
  });
});
