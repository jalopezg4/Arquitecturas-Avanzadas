const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Operator = require("../src/domain/Operator");
const DirectoryState = require("../src/domain/DirectoryState");
const { OperatorRepository } = require("../src/infrastructure/OperatorRepository");
const logger = require("../src/tracing/logger");
const { UnsafeTransferUrlError } = require("../src/security/transferUrl");
const {
  OperatorDirectoryService,
  DirectoryUnavailableError,
  OperatorNotFoundError,
  AmbiguousOperatorError,
  NoTransferEndpointError,
  SelfTransferError,
  ValidationError,
} = require("../src/application/OperatorDirectoryService");

const OWN_ID = "6aae9153b7655900026073f1";
const MIN = 60000;
const TTL = 60 * MIN;
const MAX_STALE = 24 * 60 * MIN;
const FORCED = 30 * 1000;

const op = (id, name, transferApiUrl = null) => ({ id, name, transferApiUrl, participants: [] });
const baseDirectory = () => [
  op("690d4e0e8502c8000221a5a7", "Carpeta Ciudadana", "http://carpeta.operadores.co/api/transferCitizen"),
  op(OWN_ID, "MiFolio"),
  op("65ca0a00d833e984e2608756", "Operador Norte"), // existe pero aun no publico direccion
  op("65ca0a00d833e984e2608758", "Operador Sur", "https://sur.operadores.co/api/transferCitizen"),
];

let mongoServer;
let clock;
let directory;
let client;
let repository;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
afterEach(async () => {
  jest.restoreAllMocks();
  logger.resetSink();
  await mongoose.connection.dropDatabase();
});

beforeEach(async () => {
  await Promise.all([Operator.createIndexes(), DirectoryState.createIndexes()]); // dropDatabase() borra los indices unicos
  clock = { now: new Date("2026-09-20T10:00:00Z") };
  directory = baseDirectory();
  client = { listOperators: jest.fn(async () => directory.map((o) => ({ ...o }))) };
  repository = new OperatorRepository();
});

const build = (overrides = {}) =>
  new OperatorDirectoryService({ client, repository, ownOperatorId: OWN_ID, ttlMs: TTL, maxStaleMs: MAX_STALE, minForcedRefreshMs: FORCED, now: () => clock.now, ...overrides });
const advance = (ms) => {
  clock.now = new Date(clock.now.getTime() + ms);
};

describe("OperatorDirectoryService.findOperator() -- localiza al destino via getOperators", () => {
  test("localiza por operatorId y por nombre (sin distinguir mayusculas ni espacios repetidos)", async () => {
    const service = build();

    const byId = await service.findOperator({ operatorId: "65ca0a00d833e984e2608758" });
    const byName = await service.findOperator({ name: "  carpeta   CIUDADANA " });

    expect(byId.operator).toMatchObject({ operatorId: "65ca0a00d833e984e2608758", name: "Operador Sur", transferApiUrl: "https://sur.operadores.co/api/transferCitizen" });
    expect(byName.operator.operatorId).toBe("690d4e0e8502c8000221a5a7");
    expect(byId.stale).toBe(false);
  });

  test("CACHEA el directorio localmente: muchas busquedas seguidas = UNA llamada a GovCarpeta", async () => {
    const service = build();

    for (let i = 0; i < 5; i++) await service.findOperator({ operatorId: OWN_ID });
    await service.findOperator({ name: "Operador Sur" });

    expect(client.listOperators).toHaveBeenCalledTimes(1);
    expect(await Operator.countDocuments()).toBe(4); // la copia local (entidad Operador) quedo guardada
    expect(await DirectoryState.findById("directory").lean()).toMatchObject({ count: 4 });
  });

  test("la copia local sobrevive a un reinicio: un servicio NUEVO con la misma base no vuelve a llamar", async () => {
    await build().findOperator({ operatorId: OWN_ID });
    client.listOperators.mockClear();

    await build().findOperator({ operatorId: "65ca0a00d833e984e2608758" });

    expect(client.listOperators).not.toHaveBeenCalled();
  });

  test("REFRESCA cuando la copia supera la vigencia (60 min), y no antes", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID });

    advance(59 * MIN);
    await service.findOperator({ operatorId: OWN_ID });
    expect(client.listOperators).toHaveBeenCalledTimes(1); // aun vigente

    advance(2 * MIN); // 61 min
    await service.findOperator({ operatorId: OWN_ID });
    expect(client.listOperators).toHaveBeenCalledTimes(2);
  });

  test("un refresco publica el directorio NUEVO: aparecen los operadores nuevos, desaparecen los que ya no estan y no quedan generaciones viejas", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID });
    directory = [op("aaaaaaaaaaaaaaaaaaaaaaaa", "Operador Nuevo", "https://nuevo.operadores.co/t"), op(OWN_ID, "MiFolio")];

    advance(2 * TTL);
    await expect(service.findOperator({ operatorId: "aaaaaaaaaaaaaaaaaaaaaaaa" })).resolves.toHaveProperty("operator.name", "Operador Nuevo");
    await expect(service.findOperator({ operatorId: "65ca0a00d833e984e2608758" })).rejects.toThrow(OperatorNotFoundError); // Sur ya no esta

    expect(await Operator.distinct("generation")).toHaveLength(1);
    expect(await Operator.countDocuments()).toBe(2);
  });

  test("un refresco que FALLA al escribir deja intacto el directorio anterior y no deja una generacion a medias", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID });
    const before = await DirectoryState.findById("directory").lean();
    jest.spyOn(Operator, "insertMany").mockRejectedValueOnce(new Error("mongo caido a mitad de escritura"));

    advance(2 * TTL);
    const res = await service.findOperator({ operatorId: OWN_ID }); // GovCarpeta respondio, pero no se pudo guardar: copia vieja

    expect(res.stale).toBe(true);
    expect(await Operator.distinct("generation")).toEqual([before.currentGeneration]);
    expect(await Operator.countDocuments()).toBe(4);
  });

  test("CONCURRENCIA: 10 busquedas simultaneas con la copia fria comparten UN solo refresco", async () => {
    const service = build();
    client.listOperators.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40)); // una respuesta lenta deja la ventana abierta
      return directory.map((o) => ({ ...o }));
    });

    await Promise.all(Array.from({ length: 10 }, () => service.findOperator({ operatorId: OWN_ID })));

    expect(client.listOperators).toHaveBeenCalledTimes(1);
    expect(await Operator.countDocuments()).toBe(4); // y sin operadores duplicados
  });

  test("un directorio VACIO no reemplaza a uno bueno (parece una falla de GovCarpeta, no un directorio sin operadores)", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID });
    directory = [];

    advance(2 * TTL);
    const res = await service.findOperator({ operatorId: OWN_ID });

    expect(res.stale).toBe(true);
    expect(await Operator.countDocuments()).toBe(4);
  });
});

describe("Operador no encontrado: refresco forzado, pero limitado (el directorio es compartido)", () => {
  test("no esta ni tras refrescar -> OperatorNotFoundError; y NO martilla a GovCarpeta: un solo refresco forzado cada 30 s", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID }); // 1 llamada (carga inicial)
    advance(31 * 1000);

    await expect(service.findOperator({ operatorId: "ffffffffffffffffffffffff" })).rejects.toThrow(OperatorNotFoundError);
    expect(client.listOperators).toHaveBeenCalledTimes(2); // + 1 refresco forzado

    for (let i = 0; i < 5; i++) await expect(service.findOperator({ operatorId: "ffffffffffffffffffffffff" })).rejects.toThrow(OperatorNotFoundError);
    expect(client.listOperators).toHaveBeenCalledTimes(2); // ningun refresco mas dentro de los 30 s

    advance(31 * 1000);
    await expect(service.findOperator({ operatorId: "ffffffffffffffffffffffff" })).rejects.toThrow(OperatorNotFoundError);
    expect(client.listOperators).toHaveBeenCalledTimes(3); // pasados 30 s, otro
  });

  test("un operador que se registro hace poco SI se encuentra gracias al refresco forzado", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID });
    advance(2 * MIN); // la copia sigue vigente (60 min) pero no incluye al nuevo
    directory.push(op("bbbbbbbbbbbbbbbbbbbbbbbb", "Recien Llegado", "https://nuevo.co/t"));

    const res = await service.findOperator({ operatorId: "bbbbbbbbbbbbbbbbbbbbbbbb" });

    expect(res.operator.name).toBe("Recien Llegado");
    expect(res.stale).toBe(false);
  });

  test("si el refresco forzado falla, se responde 'no encontrado' (no se rompe la busqueda)", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID });
    advance(2 * MIN);
    client.listOperators.mockRejectedValue(new Error("GovCarpeta caido"));

    await expect(service.findOperator({ operatorId: "ffffffffffffffffffffffff" })).rejects.toThrow(OperatorNotFoundError);
  });

  test("dos operadores con el mismo nombre -> AmbiguousOperatorError con sus ids; por id se distinguen", async () => {
    directory.push(op("cccccccccccccccccccccccc", "operador sur"));
    const service = build();

    const err = await service.findOperator({ name: "Operador Sur" }).catch((e) => e);

    expect(err).toBeInstanceOf(AmbiguousOperatorError);
    expect(err.operatorIds.sort()).toEqual(["65ca0a00d833e984e2608758", "cccccccccccccccccccccccc"]);
    await expect(service.findOperator({ operatorId: "cccccccccccccccccccccccc" })).resolves.toHaveProperty("operator.operatorId", "cccccccccccccccccccccccc");
  });

  test.each([
    ["ni id ni nombre", {}],
    ["ambos a la vez", { operatorId: "690d4e0e8502c8000221a5a7", name: "x" }],
    ["id con caracteres raros", { operatorId: "../etc/passwd" }],
    ["id vacio", { operatorId: "  " }],
    ["nombre enorme", { name: "x".repeat(201) }],
  ])("entrada invalida (%s) -> ValidationError sin llamar a GovCarpeta", async (_name, input) => {
    await expect(build().findOperator(input)).rejects.toThrow(ValidationError);
    expect(client.listOperators).not.toHaveBeenCalled();
  });
});

describe("GovCarpeta caido: copia vieja para BUSCAR, nunca para resolver una direccion", () => {
  test("con la copia vencida pero dentro del maximo, buscar devuelve la copia marcada stale", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID });
    client.listOperators.mockRejectedValue(new Error("GovCarpeta caido"));

    advance(2 * TTL);
    const res = await service.findOperator({ operatorId: "65ca0a00d833e984e2608758" });

    expect(res.stale).toBe(true);
    expect(res.operator.name).toBe("Operador Sur");
  });

  test("pasado el maximo de antiguedad (24 h) ya no se usa la copia: DirectoryUnavailableError", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID });
    client.listOperators.mockRejectedValue(new Error("GovCarpeta caido"));

    advance(MAX_STALE + MIN);

    await expect(service.findOperator({ operatorId: OWN_ID })).rejects.toThrow(DirectoryUnavailableError);
  });

  test("sin ninguna copia local y GovCarpeta caido -> DirectoryUnavailableError", async () => {
    client.listOperators.mockRejectedValue(new Error("GovCarpeta caido"));
    await expect(build().findOperator({ operatorId: OWN_ID })).rejects.toThrow(DirectoryUnavailableError);
  });

  test("resolveTransferAddress es ESTRICTO: con la copia vencida y GovCarpeta caido NO devuelve la direccion cacheada", async () => {
    const service = build();
    await service.resolveTransferAddress("690d4e0e8502c8000221a5a7"); // funciona con la copia vigente
    client.listOperators.mockRejectedValue(new Error("GovCarpeta caido"));

    advance(2 * TTL);

    await expect(service.findOperator({ operatorId: "690d4e0e8502c8000221a5a7" })).resolves.toHaveProperty("stale", true); // buscar si
    await expect(service.resolveTransferAddress("690d4e0e8502c8000221a5a7")).rejects.toThrow(DirectoryUnavailableError); // usar la direccion, no
  });
});

describe("OperatorDirectoryService.resolveTransferAddress() -- direccion publicada por el operador destino", () => {
  test("devuelve la direccion de transferencia del destino", async () => {
    const res = await build().resolveTransferAddress("65ca0a00d833e984e2608758");

    expect(res).toMatchObject({ operatorId: "65ca0a00d833e984e2608758", name: "Operador Sur", transferApiUrl: "https://sur.operadores.co/api/transferCitizen" });
    expect(res.refreshedAt).toBeInstanceOf(Date);
  });

  test("operador que existe pero NO publico direccion -> NoTransferEndpointError, tras UN refresco forzado (por si la publico hace un momento)", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID });
    advance(31 * 1000);
    client.listOperators.mockClear();

    await expect(service.resolveTransferAddress("65ca0a00d833e984e2608756")).rejects.toThrow(NoTransferEndpointError);
    expect(client.listOperators).toHaveBeenCalledTimes(1);

    await expect(service.resolveTransferAddress("65ca0a00d833e984e2608756")).rejects.toThrow(NoTransferEndpointError);
    expect(client.listOperators).toHaveBeenCalledTimes(1); // dentro de los 30 s no se vuelve a llamar
  });

  test("una direccion publicada DESPUES de la ultima copia se encuentra con el refresco forzado", async () => {
    const service = build();
    await service.findOperator({ operatorId: OWN_ID });
    advance(2 * MIN);
    directory.find((o) => o.id === "65ca0a00d833e984e2608756").transferApiUrl = "https://norte.operadores.co/api/transferCitizen";

    const res = await service.resolveTransferAddress("65ca0a00d833e984e2608756");

    expect(res.transferApiUrl).toBe("https://norte.operadores.co/api/transferCitizen");
  });

  test("no se puede transferir a NUESTRO propio operador (SelfTransferError), ni siquiera consultando el directorio de mas", async () => {
    await expect(build().resolveTransferAddress(OWN_ID)).rejects.toThrow(SelfTransferError);
  });

  test("operador inexistente -> OperatorNotFoundError", async () => {
    await expect(build().resolveTransferAddress("ffffffffffffffffffffffff")).rejects.toThrow(OperatorNotFoundError);
  });

  test.each([
    ["localhost", "http://localhost:8080/api/transferCitizen"],
    ["IP de loopback", "http://127.0.0.1/api/transferCitizen"],
    ["red privada", "http://10.0.0.5/api/transferCitizen"],
    ["metadatos de la nube", "http://169.254.169.254/latest/meta-data/"],
    ["esquema file", "file:///etc/passwd"],
    ["credenciales en la URL", "http://admin:secreto@operador.co/api/transferCitizen"],
    ["host interno", "http://intranet/api/transferCitizen"],
  ])("una direccion publicada por otro operador que apunta a %s se RECHAZA (SSRF)", async (_name, url) => {
    directory.find((o) => o.id === "65ca0a00d833e984e2608756").transferApiUrl = url;

    await expect(build().resolveTransferAddress("65ca0a00d833e984e2608756")).rejects.toThrow(UnsafeTransferUrlError);
  });

  test("en desarrollo local se pueden permitir direcciones privadas (allowPrivate)", async () => {
    directory.find((o) => o.id === "65ca0a00d833e984e2608756").transferApiUrl = "http://localhost:9000/api/transferCitizen";

    const res = await build({ urlPolicy: { allowPrivate: true } }).resolveTransferAddress("65ca0a00d833e984e2608756");

    expect(res.transferApiUrl).toBe("http://localhost:9000/api/transferCitizen");
  });

  test("con requireHttps se rechaza una direccion http", async () => {
    await expect(build({ urlPolicy: { requireHttps: true } }).resolveTransferAddress("690d4e0e8502c8000221a5a7")).rejects.toThrow(UnsafeTransferUrlError); // es http://
    await expect(build({ urlPolicy: { requireHttps: true } }).resolveTransferAddress("65ca0a00d833e984e2608758")).resolves.toHaveProperty("name", "Operador Sur"); // https
  });
});
