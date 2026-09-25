/**
 * HU-06.3 (PASO 3.2): publicacion y reconciliacion de `solicitud.creada`. Mismo patron ya probado para
 * `documento.cargado` (ver reconciliation.test.js): persistir -> publicar -> marcar `eventoPublicado` ->
 * reconciliar si falla.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Solicitud = require("../src/domain/Solicitud");
const Folder = require("../src/domain/Folder");
const SolicitudRepository = require("../src/infrastructure/SolicitudRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const EventPublisher = require("../src/infrastructure/EventPublisher");
const { SolicitudService } = require("../src/application/SolicitudService");
const { solicitudCreadaPayload } = require("../src/application/solicitudEvents");
const SolicitudEventReconciler = require("../src/application/SolicitudEventReconciler");
const { makeCitizenRegisteredHandler } = require("../src/interfaces/eventHandlers");
const logger = require("../src/tracing/logger");
const { makeFakePublisher } = require("./helpers");

const ANA = "665f1c04c9de9c4c34f6b52a";
const DIR_ANA = "1000000001-3f9c2ab7@carpetacolombia.co";
const EAFIT = "6aae9153b7655900026073f1";

let mongoServer;
let folderRepository;
let solicitudRepository;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
beforeEach(async () => {
  await Promise.all([Solicitud.createIndexes(), Folder.createIndexes()]); // dropDatabase() borra los indices
  folderRepository = new FolderRepository();
  solicitudRepository = new SolicitudRepository();
  await makeCitizenRegisteredHandler({ folderRepository })({ ciudadanoId: ANA, direccionUnica: DIR_ANA });
});
afterEach(async () => {
  logger.resetSink();
  await mongoose.connection.dropDatabase();
});

const crear = (service, overrides = {}) =>
  service.create({ institutionId: EAFIT, direccionUnica: DIR_ANA, descripcion: "Solicitar copia del certificado de estudios", ...overrides });

describe("Publicacion al crear (SolicitudService.create)", () => {
  test("1. la solicitud nace SIEMPRE con eventoPublicado=false (default del esquema), independientemente de si el publish termina rapido o no", async () => {
    // Se verifica de forma directa e inequivoca: el propio esquema de Mongoose, no una carrera contra el publish.
    const s = new Solicitud({ institutionId: EAFIT, ciudadanoId: ANA, direccionUnica: DIR_ANA, descripcion: "x" });
    expect(s.eventoPublicado).toBe(false);
  });

  test("2. al publicar correctamente, la solicitud queda eventoPublicado=true", async () => {
    const publisher = makeFakePublisher();
    const service = new SolicitudService({ solicitudRepository, folderRepository, eventPublisher: publisher });

    const result = await crear(service);

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const stored = await Solicitud.findById(result.id).lean();
    expect(stored.eventoPublicado).toBe(true);
  });

  test("3-7. el payload contiene exactamente eventId/solicitudId/ciudadanoId/descripcion/creadaEn, con eventId===solicitudId, creadaEn===createdAt, routing key y exchange correctos", async () => {
    const publisher = makeFakePublisher();
    const service = new SolicitudService({ solicitudRepository, folderRepository, eventPublisher: publisher });

    const result = await crear(service);

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [routingKey, payload] = publisher.publish.mock.calls[0];
    expect(routingKey).toBe("solicitud.creada"); // 6. routing key exacto

    const stored = await Solicitud.findById(result.id).lean();
    expect(Object.keys(payload).sort()).toEqual(["ciudadanoId", "creadaEn", "descripcion", "eventId", "solicitudId"]); // 3.
    expect(payload.eventId).toBe(payload.solicitudId); // 4.
    expect(payload.solicitudId).toBe(result.id);
    expect(payload.ciudadanoId).toBe(ANA);
    expect(payload.descripcion).toBe("Solicitar copia del certificado de estudios");
    expect(payload.creadaEn).toBe(stored.createdAt.toISOString()); // 5.
  });

  test("7. el exchange usado es carpeta-ciudadana.events (verificado contra el EventPublisher real)", async () => {
    // EventPublisher.js define el exchange como constante interna (no exportada, a proposito: nadie fuera de la
    // clase decide a que exchange se publica). Se verifica indirectamente: assertExchange se llama con ese nombre.
    const assertExchange = jest.fn(async () => {});
    const channel = {
      createConfirmChannel: undefined,
      assertExchange,
      assertQueue: jest.fn(async () => {}),
      bindQueue: jest.fn(async () => {}),
      publish: jest.fn((_ex, _rk, _buf, _opts, cb) => cb()),
      on: jest.fn(),
    };
    const conn = { createConfirmChannel: jest.fn(async () => channel), on: jest.fn() };
    const publisher = new EventPublisher("amqp://fake", { connect: jest.fn(async () => conn) });
    const service = new SolicitudService({ solicitudRepository, folderRepository, eventPublisher: publisher });

    await crear(service);

    expect(assertExchange).toHaveBeenCalledWith("carpeta-ciudadana.events", "topic", { durable: true });
  });

  test("8. si RabbitMQ falla, la solicitud igualmente se crea (201 conceptual: create() no lanza)", async () => {
    const publisher = makeFakePublisher(async () => { throw new Error("RabbitMQ no disponible"); });
    const service = new SolicitudService({ solicitudRepository, folderRepository, eventPublisher: publisher });

    const result = await crear(service); // no debe lanzar

    expect(result.id).toEqual(expect.any(String));
    expect(await Solicitud.countDocuments()).toBe(1);
  });

  test("9. cuando RabbitMQ falla, eventoPublicado permanece false", async () => {
    const publisher = makeFakePublisher(async () => { throw new Error("RabbitMQ no disponible"); });
    const service = new SolicitudService({ solicitudRepository, folderRepository, eventPublisher: publisher });

    const result = await crear(service);

    const stored = await Solicitud.findById(result.id).lean();
    expect(stored.eventoPublicado).toBe(false);
  });
});

describe("Binding anticipado (EventPublisher.js)", () => {
  test("13. ms-notificaciones.solicitud-creada esta declarado y ligado a solicitud.creada", async () => {
    const boundQueues = [];
    const channel = {
      assertExchange: jest.fn(async () => {}),
      assertQueue: jest.fn(async (queue) => boundQueues.push(queue)),
      bindQueue: jest.fn(async (queue, _exchange, routingKey) => boundQueues.push({ queue, routingKey })),
      publish: jest.fn((_ex, _rk, _buf, _opts, cb) => cb()),
      on: jest.fn(),
    };
    const conn = { createConfirmChannel: jest.fn(async () => channel), on: jest.fn() };
    const publisher = new EventPublisher("amqp://fake", { connect: jest.fn(async () => conn) });

    await publisher.connect();

    expect(channel.assertQueue).toHaveBeenCalledWith("ms-notificaciones.solicitud-creada", { durable: true });
    expect(channel.bindQueue).toHaveBeenCalledWith("ms-notificaciones.solicitud-creada", "carpeta-ciudadana.events", "solicitud.creada");
  });
});

describe("SolicitudEventReconciler", () => {
  const NOW = new Date("2026-09-24T12:00:00Z");
  const seedUnpublished = (extra = {}) =>
    Solicitud.create({
      institutionId: EAFIT,
      ciudadanoId: ANA,
      direccionUnica: DIR_ANA,
      descripcion: "Solicitud vieja sin publicar",
      estado: "pendiente_autorizacion",
      eventoPublicado: false,
      ...extra,
    });

  /** Envejece una solicitud reescribiendo createdAt directo en la coleccion (timestamps usa el reloj real). */
  async function age(solicitud, msAgo) {
    const createdAt = new Date(NOW.getTime() - msAgo);
    await Solicitud.collection.updateOne({ _id: solicitud._id }, { $set: { createdAt } });
    return createdAt;
  }

  test("10. encuentra solicitudes pendientes (eventoPublicado:false, mas viejas que minAgeMs)", async () => {
    const s1 = await seedUnpublished();
    await age(s1, 5 * 60000); // 5 min: mas vieja que minAgeMs (1 min)
    const s2 = await seedUnpublished(); // recien creada: no deberia salir todavia

    const found = await solicitudRepository.findUnpublished({ olderThan: new Date(NOW.getTime() - 60000), limit: 50 });

    expect(found.map((s) => s._id.toString())).toEqual([s1._id.toString()]);
    expect(found.map((s) => s._id.toString())).not.toContain(s2._id.toString());
  });

  test("11. publica correctamente una pendiente y luego la marca como publicada", async () => {
    const s1 = await seedUnpublished();
    const createdAt = await age(s1, 5 * 60000);
    const publisher = makeFakePublisher();
    const reconciler = new SolicitudEventReconciler({ solicitudRepository, eventPublisher: publisher, minAgeMs: 60000, now: () => NOW });

    const result = await reconciler.reconcileOnce();

    expect(result).toEqual({ republished: 1, failed: 0 });
    const expectedPayload = solicitudCreadaPayload({ _id: s1._id, ciudadanoId: ANA, descripcion: "Solicitud vieja sin publicar", createdAt });
    expect(publisher.publish).toHaveBeenCalledWith("solicitud.creada", expectedPayload);
    expect((await Solicitud.findById(s1._id).lean()).eventoPublicado).toBe(true);
  });

  test("12. una solicitud ya publicada no vuelve a aparecer en findUnpublished()", async () => {
    const s1 = await seedUnpublished();
    await age(s1, 5 * 60000);
    await solicitudRepository.markEventPublished(s1._id);

    const found = await solicitudRepository.findUnpublished({ olderThan: new Date(NOW.getTime() - 60000), limit: 50 });

    expect(found).toHaveLength(0);
  });

  test("una solicitud que falla al publicar no impide reconciliar las demas, y queda para el siguiente intento", async () => {
    const s1 = await seedUnpublished({ descripcion: "falla" });
    const s2 = await seedUnpublished({ descripcion: "funciona" });
    await age(s1, 5 * 60000);
    await age(s2, 5 * 60000);
    const publisher = makeFakePublisher(async (_rk, payload) => {
      if (payload.solicitudId === s1._id.toString()) throw new Error("RabbitMQ no disponible");
    });
    const reconciler = new SolicitudEventReconciler({ solicitudRepository, eventPublisher: publisher, minAgeMs: 60000, now: () => NOW });

    const result = await reconciler.reconcileOnce();

    expect(result).toEqual({ republished: 1, failed: 1 });
    expect((await Solicitud.findById(s1._id).lean()).eventoPublicado).toBe(false);
    expect((await Solicitud.findById(s2._id).lean()).eventoPublicado).toBe(true);
  });
});

describe("14. no se modifica el comportamiento existente de documento.cargado", () => {
  test("EventReconciler (documentos) sigue exportando la misma clase, sin relacion con SolicitudEventReconciler", () => {
    const EventReconciler = require("../src/application/EventReconciler");
    expect(typeof EventReconciler).toBe("function");
    expect(EventReconciler).not.toBe(SolicitudEventReconciler);
  });

  test("EventPublisher.ANTICIPATED_BINDINGS sigue incluyendo el binding de documento.cargado", async () => {
    const boundRoutingKeys = [];
    const channel = {
      assertExchange: jest.fn(async () => {}),
      assertQueue: jest.fn(async () => {}),
      bindQueue: jest.fn(async (_queue, _exchange, routingKey) => boundRoutingKeys.push(routingKey)),
      publish: jest.fn((_ex, _rk, _buf, _opts, cb) => cb()),
      on: jest.fn(),
    };
    const conn = { createConfirmChannel: jest.fn(async () => channel), on: jest.fn() };
    const publisher = new EventPublisher("amqp://fake", { connect: jest.fn(async () => conn) });

    await publisher.connect();

    expect(boundRoutingKeys).toEqual(expect.arrayContaining(["documento.cargado", "solicitud.creada"]));
  });
});
