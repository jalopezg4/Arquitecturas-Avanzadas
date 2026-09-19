const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { EventEmitter } = require("events");
const request = require("supertest");

const buildApp = require("../src/app");
const Citizen = require("../src/domain/Citizen");
const AuditEntry = require("../src/domain/AuditEntry");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const EventPublisher = require("../src/infrastructure/EventPublisher");
const PendingRegistrationReconciler = require("../src/application/PendingRegistrationReconciler");
const { CitizenSagaService } = require("../src/application/CitizenSagaService");
const logger = require("../src/tracing/logger");

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
  await Promise.all([Citizen.createIndexes(), AuditEntry.createIndexes()]); // dropDatabase() borra los indices unicos
});
afterEach(async () => {
  logger.resetSink();
  await mongoose.connection.dropDatabase();
});

const NOW = new Date(); // reloj real: las escrituras de las pruebas usan la hora real, y la ventana de antiguedad debe ser coherente
let seq = 0;
const seed = async (extra = {}) => {
  seq++;
  const c = await Citizen.create({ documento: 1000000000 + seq, nombre: "Ana", direccion: "d", correo: "ana@e.co", passwordHash: "x", direccionUnica: `u${seq}@carpetacolombia.co`, estado: "pendiente", ...extra });
  return c;
};
const backdate = (c, ms) => Citizen.collection.updateOne({ _id: c._id }, { $set: { createdAt: new Date(NOW.getTime() - ms), updatedAt: new Date(NOW.getTime() - ms) } });
const old = async (extra) => {
  const c = await seed(extra);
  await backdate(c, 10 * 60000);
  return c;
};

const gov = (available) => ({ validateCitizen: jest.fn(async () => (typeof available === "function" ? available() : { available })) });
const publisher = (impl) => ({ publish: jest.fn(impl || (async () => {})) });

function build({ govClient, pub, minAgeMs = 5 * 60000, audit = true } = {}) {
  return new PendingRegistrationReconciler({
    citizenRepository: new CitizenRepository(),
    govCarpetaClient: govClient,
    eventPublisher: pub || publisher(),
    auditLogger: audit ? new AuditLogger({ auditRepository: new AuditRepository() }) : undefined,
    minAgeMs,
    now: () => NOW,
  });
}

describe("PendingRegistrationReconciler: pendientes que quedaron dudosos", () => {
  test("GovCarpeta NO lo tiene (disponible) -> se descarta el pendiente y el documento puede registrarse de nuevo", async () => {
    const c = await old();
    const r = build({ govClient: gov(true) });

    expect(await r.reconcileOnce()).toMatchObject({ discarded: 1, activated: 0 });

    expect(await Citizen.countDocuments()).toBe(0);
    const entry = await AuditEntry.findOne({ action: "ciudadano.registrar" }).lean();
    expect(entry).toMatchObject({ outcome: "fallo", reason: "reconciliado_no_aceptado_por_govcarpeta", actor: String(c.documento) });
  });

  test("GovCarpeta SI lo tiene (afiliado) -> se activa, se publica ciudadano.registrado y se marca publicado", async () => {
    const c = await old();
    const pub = publisher();

    expect(await build({ govClient: gov(false), pub }).reconcileOnce()).toMatchObject({ activated: 1, discarded: 0 });

    const after = await Citizen.findById(c._id).lean();
    expect(after).toMatchObject({ estado: "activo", eventoPublicado: true });
    const [key, payload] = pub.publish.mock.calls[0];
    expect(key).toBe("ciudadano.registrado");
    expect(payload).toMatchObject({ ciudadanoId: String(c._id), documento: c.documento, nombre: "Ana", correo: "ana@e.co" });
    expect(JSON.stringify(payload)).not.toMatch(/passwordHash|password/);
    expect(await AuditEntry.findOne({ outcome: "exito", reason: "reconciliado" })).toBeTruthy();
  });

  test("GovCarpeta no responde -> no se decide nada: sigue pendiente y se reintenta despues", async () => {
    const c = await old();
    const r = build({
      govClient: gov(() => {
        throw new Error("timeout");
      }),
    });

    expect(await r.reconcileOnce()).toMatchObject({ skipped: 1, activated: 0, discarded: 0 });
    expect((await Citizen.findById(c._id)).estado).toBe("pendiente");

    expect(await build({ govClient: gov(true) }).reconcileOnce()).toMatchObject({ discarded: 1 });
  });

  test("un pendiente RECIENTE no se toca (su saga puede seguir en curso)", async () => {
    const c = await seed();
    await backdate(c, 30000);
    const g = gov(true);

    expect(await build({ govClient: g }).reconcileOnce()).toMatchObject({ discarded: 0, activated: 0 });
    expect(g.validateCitizen).not.toHaveBeenCalled();
    expect(await Citizen.countDocuments()).toBe(1);
  });

  test("nunca borra ni degrada a un ciudadano ACTIVO, aunque GovCarpeta diga 'disponible'", async () => {
    const c = await old({ estado: "activo", eventoPublicado: true });
    const g = gov(true);

    await build({ govClient: g }).reconcileOnce();

    expect(g.validateCitizen).not.toHaveBeenCalled();
    expect((await Citizen.findById(c._id)).estado).toBe("activo");
  });

  test("CARRERA: si la saga lo activa mientras se reconcilia, no se pisa ni se publica dos veces", async () => {
    const c = await old();
    const pub = publisher();
    const g = gov(() => {
      // durante la consulta a GovCarpeta, la saga original termina y lo activa
      return Citizen.updateOne({ _id: c._id }, { estado: "activo", eventoPublicado: true }).then(() => ({ available: false }));
    });

    const res = await build({ govClient: g, pub }).reconcileOnce();

    expect(res.activated).toBe(0);
    expect(pub.publish).not.toHaveBeenCalled();
    expect((await Citizen.findById(c._id)).estado).toBe("activo");
  });

  test("CARRERA: si se activa mientras se decide descartar, el borrado condicional NO lo elimina", async () => {
    const c = await old();
    const g = gov(async () => {
      await Citizen.updateOne({ _id: c._id }, { estado: "activo" });
      return { available: true };
    });

    expect(await build({ govClient: g }).reconcileOnce()).toMatchObject({ discarded: 0 });
    expect(await Citizen.countDocuments({ estado: "activo" })).toBe(1);
  });

  test("dos replicas a la vez: se activa UNA sola vez y se publica UNA sola vez", async () => {
    await old();
    const pub = publisher();

    const [a, b] = await Promise.all([build({ govClient: gov(false), pub }).reconcileOnce(), build({ govClient: gov(false), pub }).reconcileOnce()]);

    expect(a.activated + b.activated).toBe(1);
    expect(pub.publish).toHaveBeenCalledTimes(1);
  });

  test("un pendiente que falla no impide resolver los demas", async () => {
    const a = await old();
    await old();
    let n = 0;
    const g = gov(() => {
      if (++n === 1) throw new Error("timeout");
      return { available: true };
    });

    expect(await build({ govClient: g }).reconcileOnce()).toMatchObject({ skipped: 1, discarded: 1 });
    expect((await Citizen.findById(a._id)).estado).toBe("pendiente");
  });

  test("si la bitacora falla, la reconciliacion sigue (se reporta, no se cae)", async () => {
    await old();
    const r = build({ govClient: gov(true), audit: false });
    r.auditLogger = {
      record: async () => {
        throw new Error("mongo caido");
      },
    };

    expect(await r.reconcileOnce()).toMatchObject({ discarded: 1 });
  });
});

describe("ciudadano.registrado que no llego al broker se reenvia", () => {
  test("un ciudadano activo con eventoPublicado:false se reenvia y se marca; la siguiente pasada ya no lo repite", async () => {
    const c = await old({ estado: "activo", eventoPublicado: false });
    const pub = publisher();
    const r = build({ govClient: gov(true), pub });

    expect(await r.reconcileOnce()).toMatchObject({ republished: 1 });
    expect(await r.reconcileOnce()).toMatchObject({ republished: 0 });

    expect(pub.publish).toHaveBeenCalledTimes(1);
    expect(pub.publish.mock.calls[0][1].ciudadanoId).toBe(String(c._id));
    expect((await Citizen.findById(c._id)).eventoPublicado).toBe(true);
  });

  test("con el broker caido sigue pendiente de reenvio (no se marca publicado)", async () => {
    const c = await old({ estado: "activo", eventoPublicado: false });
    const r = build({
      govClient: gov(true),
      pub: publisher(async () => {
        throw new Error("broker caido");
      }),
    });

    expect(await r.reconcileOnce()).toMatchObject({ republished: 0, skipped: 1 });
    expect((await Citizen.findById(c._id)).eventoPublicado).toBe(false);
  });

  test("los ciudadanos anteriores a este campo (sin eventoPublicado) NO se reenvian en masa", async () => {
    const c = await old({ estado: "activo" });
    await Citizen.collection.updateOne({ _id: c._id }, { $unset: { eventoPublicado: "" } });
    const pub = publisher();

    expect(await build({ govClient: gov(true), pub }).reconcileOnce()).toMatchObject({ republished: 0 });
    expect(pub.publish).not.toHaveBeenCalled();
  });

  test("extremo a extremo: registrar con el broker caido deja el evento pendiente y luego se reenvia", async () => {
    let brokerUp = false;
    const pub = publisher(async () => {
      if (!brokerUp) throw new Error("broker caido");
    });
    const govClient = { validateCitizen: async () => ({ available: true }), registerCitizen: async () => {}, unregisterCitizen: async () => {} };
    const repo = new CitizenRepository();
    const app = buildApp({ citizenSagaService: new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: govClient, eventPublisher: pub }) });

    const res = await request(app).post("/api/v1/citizens").send({ documento: 1555666777, nombre: "Ana", direccion: "d", correo: "ana@e.co", password: "Sup3rSecreta!" });
    expect(res.status).toBe(201); // el registro NO falla porque el broker este caido (ADR-04)
    const c = await Citizen.findOne({ documento: 1555666777 });
    expect(c).toMatchObject({ estado: "activo", eventoPublicado: false });

    brokerUp = true;
    await backdate(c, 10 * 60000);
    pub.publish.mockClear();
    expect(await build({ govClient, pub }).reconcileOnce()).toMatchObject({ republished: 1 });
    expect((await Citizen.findById(c._id)).eventoPublicado).toBe(true);
  });

  test("un registro normal (broker sano) queda marcado como publicado desde el inicio", async () => {
    const pub = publisher();
    const govClient = { validateCitizen: async () => ({ available: true }), registerCitizen: async () => {}, unregisterCitizen: async () => {} };
    const app = buildApp({ citizenSagaService: new CitizenSagaService({ citizenRepository: new CitizenRepository(), govCarpetaClient: govClient, eventPublisher: pub }) });

    await request(app).post("/api/v1/citizens").send({ documento: 1555666778, nombre: "Ana", direccion: "d", correo: "ana@e.co", password: "Sup3rSecreta!" }).expect(201);

    expect(await Citizen.findOne({ documento: 1555666778 })).toMatchObject({ eventoPublicado: true });
  });
});

describe("ciclo periodico", () => {
  test("start() no se solapa consigo misma, sobrevive a errores y stop() la detiene", async () => {
    jest.useFakeTimers();
    try {
      const r = build({ govClient: gov(true) });
      let running = 0;
      let peak = 0;
      let calls = 0;
      r.reconcileOnce = async () => {
        calls++;
        peak = Math.max(peak, ++running);
        await new Promise((res) => setTimeout(res, 250));
        running--;
        if (calls === 2) throw new Error("mongo caido");
      };

      r.start(100);
      await jest.advanceTimersByTimeAsync(1500);
      expect(peak).toBe(1);
      expect(calls).toBeGreaterThan(2); // siguio despues del error

      r.stop();
      const seen = calls;
      await jest.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(seen);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("EventPublisher de identidad: se recupera cuando RabbitMQ se reinicia", () => {
  function makeBroker() {
    const broker = { connects: 0, published: [], conns: [], down: false };
    broker.connect = jest.fn(async () => {
      if (broker.down) throw new Error("ECONNREFUSED");
      broker.connects++;
      const conn = new EventEmitter();
      const channel = new EventEmitter();
      channel.assertExchange = async () => {};
      channel.assertQueue = jest.fn(async () => {});
      channel.bindQueue = async () => {};
      channel.publish = (ex, key, buf, _o, cb) => {
        if (channel.closed) throw new Error("Channel closed");
        broker.published.push(JSON.parse(buf.toString()));
        cb(null);
      };
      conn.createConfirmChannel = async () => channel;
      conn.kill = () => {
        channel.closed = true;
        conn.emit("close");
      };
      broker.conns.push({ conn, channel });
      return conn;
    });
    return broker;
  }

  test("tras reiniciarse el broker, la siguiente publicacion reconecta sola", async () => {
    const broker = makeBroker();
    const pub = new EventPublisher("amqp://x", { connect: broker.connect });
    await pub.publish("ciudadano.registrado", { n: 1 });

    broker.conns[0].conn.kill();
    await pub.publish("ciudadano.registrado", { n: 2 });

    expect(broker.connects).toBe(2);
    expect(broker.published.map((p) => p.n)).toEqual([1, 2]);
  });

  test("declara las colas de ms-documentos y ms-notificaciones para que los mensajes esperen", async () => {
    const broker = makeBroker();
    const pub = new EventPublisher("amqp://x", { connect: broker.connect });
    await pub.publish("ciudadano.registrado", {});

    const queues = broker.conns[0].channel.assertQueue.mock.calls.map((c) => c[0]);
    expect(queues).toEqual(expect.arrayContaining(["ms-documentos.ciudadano-registrado", "ms-notificaciones.ciudadano-registrado"]));
  });

  test("publicaciones simultaneas comparten UNA apertura y un 'error' de la conexion no tumba el proceso", async () => {
    const broker = makeBroker();
    const pub = new EventPublisher("amqp://x", { connect: broker.connect });

    await Promise.all(Array.from({ length: 5 }, (_, i) => pub.publish("k", { n: i })));

    expect(broker.connects).toBe(1);
    expect(() => broker.conns[0].conn.emit("error", new Error("reset"))).not.toThrow();
  });
});
