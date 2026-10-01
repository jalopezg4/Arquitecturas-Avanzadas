/**
 * HU-05c, ola 1: base de la transferencia en ms-interoperabilidad -- copia local del ciudadano, persistencia de la
 * saga con transiciones condicionales y cliente de afiliacion de GovCarpeta.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Citizen = require("../src/domain/Citizen");
const Transfer = require("../src/domain/Transfer");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const { TransferRepository, TransferConflictError } = require("../src/infrastructure/TransferRepository");
const GovCarpetaCitizenClient = require("../src/infrastructure/GovCarpetaCitizenClient");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { makeCitizenRegisteredHandler } = require("../src/interfaces/eventHandlers");
const { runWithTrace } = require("../src/tracing/TraceContext");

const ANA = "6aae9153b7655900026073f1";

let mongoServer;
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
  await Promise.all([Citizen.createIndexes(), Transfer.createIndexes()]);
});

describe("ciudadano.registrado -> copia local del ciudadano", () => {
  const registrado = { ciudadanoId: ANA, documento: 1000000001, nombre: "Ana Gomez", correo: "ana@example.com", direccionUnica: "1000000001-3f9c2ab7@carpetacolombia.co" };

  test("guarda cedula, nombre, correo y direccion unica; una reentrega no duplica", async () => {
    const handler = makeCitizenRegisteredHandler({ citizenRepository: new CitizenRepository() });

    await handler(registrado);
    await Promise.all([handler(registrado), handler(registrado)]);

    expect(await Citizen.countDocuments()).toBe(1);
    expect(await new CitizenRepository().find(ANA)).toMatchObject({ documento: 1000000001, nombre: "Ana Gomez", correo: "ana@example.com", direccionUnica: registrado.direccionUnica });
  });

  test.each([
    ["sin ciudadanoId", { ciudadanoId: undefined }],
    ["cedula como texto", { documento: "1000000001" }],
    ["sin correo (evento anterior al enriquecimiento)", { correo: undefined }],
    ["sin nombre", { nombre: "" }],
  ])("%s -> cola de fallidos", async (_caso, extra) => {
    const handler = makeCitizenRegisteredHandler({ citizenRepository: new CitizenRepository() });
    await expect(handler({ ...registrado, ...extra })).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("TransferRepository", () => {
  const saliente = (extra = {}) => ({ tipo: "saliente", estado: "exportando", ciudadanoId: ANA, documento: 1000000001, iniciadaEn: new Date(), ...extra });

  test("no permite dos transferencias VIVAS del mismo ciudadano (ni siquiera simultaneas)", async () => {
    const repo = new TransferRepository();

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => repo.create(saliente())));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => r.reason instanceof TransferConflictError)).toBe(true);
  });

  test("una transferencia terminada no bloquea una nueva", async () => {
    const repo = new TransferRepository();
    const t = await repo.create(saliente());
    await repo.transition(t._id, "exportando", "fallida", { motivo: "prueba" });

    await expect(repo.create(saliente())).resolves.toMatchObject({ activa: true });
  });

  test("transition es condicional: solo una de dos transiciones simultaneas desde el mismo estado gana", async () => {
    const repo = new TransferRepository();
    const t = await repo.create(saliente());

    const [a, b] = await Promise.all([repo.transition(t._id, "exportando", "enviando"), repo.transition(t._id, "exportando", "fallida")]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  test("un estado terminal cierra la transferencia (activa=false, sin revision pendiente)", async () => {
    const repo = new TransferRepository();
    const t = await repo.create(saliente({ revisarEn: new Date() }));

    const done = await repo.transition(t._id, "exportando", "completada");

    expect(done).toMatchObject({ activa: false, revisarEn: null });
    expect(done.finalizadaEn).toBeInstanceOf(Date);
  });

  test("findDue trae solo las vivas con el plazo vencido", async () => {
    const repo = new TransferRepository();
    const now = new Date("2026-09-26T15:00:00Z");
    const vencida = await repo.create(saliente({ revisarEn: new Date("2026-09-26T14:00:00Z") }));
    await repo.create({ ...saliente({ ciudadanoId: "otro", documento: 2, revisarEn: new Date("2026-09-26T16:00:00Z") }) });

    expect((await repo.findDue(now)).map((t) => String(t._id))).toEqual([String(vencida._id)]);
  });
});

describe("GovCarpetaCitizenClient", () => {
  const make = (responses, extra = {}) => {
    const queue = [...responses];
    const next = async () => {
      const r = queue.shift();
      if (r instanceof Error) throw r;
      return r;
    };
    const http = { delete: jest.fn(next), post: jest.fn(next) };
    return { http, client: new GovCarpetaCitizenClient({ baseUrl: "http://gov.test", operatorId: "6aae9153b7655900026073f1", operatorName: "MiFolio", http, sleep: async () => {}, ...extra }) };
  };

  test("unregisterCitizen envia {id:number, operatorId, operatorName} de NUESTRO operador y propaga el trace-id", async () => {
    const { http, client } = make([{ status: 201 }]);

    await runWithTrace("trace-hu05c-abcdef", () => client.unregisterCitizen("1000000001"));

    const [url, options] = http.delete.mock.calls[0];
    expect(url).toBe("http://gov.test/apis/unregisterCitizen");
    expect(options.data).toEqual({ id: 1000000001, operatorId: "6aae9153b7655900026073f1", operatorName: "MiFolio" });
    expect(options.headers["x-trace-id"]).toBe("trace-hu05c-abcdef");
  });

  test("unregisterCitizen reintenta 500/red y acepta 204 (no estaba afiliado)", async () => {
    const { http, client } = make([{ status: 500 }, new Error("ECONNRESET"), { status: 204 }]);
    await expect(client.unregisterCitizen(1)).resolves.toEqual({ status: 204 });
    expect(http.delete).toHaveBeenCalledTimes(3);
  });

  test("unregisterCitizen: 501 es definitivo y no se reintenta", async () => {
    const { http, client } = make([{ status: 501 }]);
    await expect(client.unregisterCitizen(1)).rejects.toMatchObject({ definitive: true });
    expect(http.delete).toHaveBeenCalledTimes(1);
  });

  test("registerCitizen NUNCA se reintenta (un reintento responderia 501 aunque haya funcionado)", async () => {
    const { http, client } = make([{ status: 500 }]);
    await expect(client.registerCitizen({ id: 1, name: "Ana", address: "Calle 1", email: "a@b.co" })).rejects.toThrow();
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  // Revision del PR #90: misma clasificacion HTTP en todos los clientes de GovCarpeta (httpStatus.js).
  test.each([502, 503, 504, 429])("unregisterCitizen reintenta un %i (router/dyno de Heroku)", async (status) => {
    const { http, client } = make([{ status }, { status: 201 }]);
    await expect(client.unregisterCitizen(1)).resolves.toEqual({ status: 201 });
    expect(http.delete).toHaveBeenCalledTimes(2);
  });

  test.each([[503, false], [429, false], [501, true], [400, true]])("registerCitizen con %i -> definitive=%s (lo transitorio lo reintenta el barrido)", async (status, definitive) => {
    const { client } = make([{ status }]);
    await expect(client.registerCitizen({ id: 1, name: "Ana", address: "Calle 1", email: "a@b.co" })).rejects.toMatchObject({ definitive });
  });

  test("sin OPERATOR_ID falla antes de llamar a GovCarpeta", async () => {
    const { http, client } = make([], { operatorId: "" });
    await expect(client.unregisterCitizen(1)).rejects.toThrow(/OPERATOR_ID/);
    expect(http.delete).not.toHaveBeenCalled();
  });
});
