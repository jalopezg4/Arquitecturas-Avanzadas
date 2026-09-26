/**
 * HU-05c, ola 4: ms-identidad en la transferencia -- borra al ciudadano que se va (origen) e importa al que llega
 * conservando su direccion unica (destino, RF-10). Mongo en memoria; GovCarpeta y el broker simulados.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Citizen = require("../src/domain/Citizen");
const RefreshSession = require("../src/domain/RefreshSession");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const RefreshSessionRepository = require("../src/infrastructure/RefreshSessionRepository");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { CitizenTransferService } = require("../src/application/CitizenTransferService");
const { makeTransferHandlers } = require("../src/interfaces/eventHandlers");

const T1 = "6ab68fddb64d2aa730b41501";
const NUEVO_ID = "6ab68fddb64d2aa730b415f0";
const DIR = "1000000001-3f9c2ab7@carpetacolombia.co";

let mongoServer;
let govCarpeta;
let publisher;
let handlers;

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
  await Citizen.createIndexes();
  govCarpeta = { registerCitizen: jest.fn(async () => {}), validateCitizen: jest.fn(async () => ({ available: true })) };
  publisher = { publish: jest.fn(async () => {}) };
  handlers = makeTransferHandlers({
    citizenTransferService: new CitizenTransferService({
      citizenRepository: new CitizenRepository(),
      refreshSessionRepository: new RefreshSessionRepository(),
      govCarpetaClient: govCarpeta,
      eventPublisher: publisher,
      eventPublishTimeoutMs: 200,
    }),
  });
});

const published = (rk) => publisher.publish.mock.calls.filter(([k]) => k === rk).map(([, p]) => p);
const llegada = (extra = {}) => ({ transferenciaId: T1, ciudadanoId: NUEVO_ID, documento: 1000000001, nombre: "Ana Gomez", correo: "ana@example.com", direccion: "Calle 1", direccionUnica: DIR, ...extra });

describe("ciudadano.transferido (origen)", () => {
  test("revoca todas las sesiones y borra al ciudadano; repetirlo no hace nada", async () => {
    const ana = await Citizen.create({ documento: 1000000001, nombre: "Ana", direccion: "Calle 1", correo: "a@b.co", passwordHash: "$argon2id$x", direccionUnica: DIR, estado: "activo" });
    await RefreshSession.create({ familia: "f1", ciudadanoId: ana._id, currentJti: "j1", expiresAt: new Date(Date.now() + 3600e3) });

    await handlers.ciudadanoTransferido({ transferenciaId: T1, ciudadanoId: String(ana._id) });
    await handlers.ciudadanoTransferido({ transferenciaId: T1, ciudadanoId: String(ana._id) });

    expect(await Citizen.countDocuments()).toBe(0);
    expect((await RefreshSession.findOne().lean()).revokedAt).toBeInstanceOf(Date);
  });

  test("mensaje invalido -> cola de fallidos", async () => {
    await expect(handlers.ciudadanoTransferido({ transferenciaId: T1, ciudadanoId: "no-es-id" })).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("transferencia.registrar_ciudadano (destino)", () => {
  test("crea al ciudadano CONSERVANDO su direccion unica (RF-10), lo afilia a nosotros y publica ciudadano.registrado", async () => {
    await handlers.registrarCiudadano(llegada());

    const ana = await Citizen.findById(NUEVO_ID).lean();
    expect(ana).toMatchObject({ documento: 1000000001, direccionUnica: DIR, estado: "activo", passwordHash: null, eventoPublicado: true });
    expect(govCarpeta.registerCitizen).toHaveBeenCalledWith({ id: 1000000001, name: "Ana Gomez", address: "Calle 1", email: "ana@example.com" });
    expect(published("ciudadano.registrado")[0]).toMatchObject({ ciudadanoId: NUEVO_ID, documento: 1000000001, direccionUnica: DIR });
    expect(published("transferencia.ciudadano_registrado")).toEqual([{ transferenciaId: T1, ciudadanoId: NUEVO_ID, ok: true, direccionUnica: DIR }]);
  });

  test("se persiste pendiente ANTES de llamar a GovCarpeta (mismo orden que la saga de HU-01)", async () => {
    govCarpeta.registerCitizen.mockImplementationOnce(async () => {
      expect((await Citizen.findById(NUEVO_ID).lean()).estado).toBe("pendiente");
    });
    await handlers.registrarCiudadano(llegada());
    expect(govCarpeta.registerCitizen).toHaveBeenCalledTimes(1);
  });

  test("una reentrega del mismo mensaje no duplica ni vuelve a llamar a GovCarpeta", async () => {
    await handlers.registrarCiudadano(llegada());
    await handlers.registrarCiudadano(llegada());

    expect(await Citizen.countDocuments()).toBe(1);
    expect(govCarpeta.registerCitizen).toHaveBeenCalledTimes(1);
    expect(published("transferencia.ciudadano_registrado").map((p) => p.ok)).toEqual([true, true]);
  });

  test("sin direccionUnica del origen genera una (queda constancia): RF-10 no se puede cumplir si no viaja", async () => {
    await handlers.registrarCiudadano(llegada({ direccionUnica: undefined }));
    expect((await Citizen.findById(NUEVO_ID).lean()).direccionUnica).toMatch(/^1000000001-[0-9a-f]{8}@carpetacolombia\.co$/);
  });

  test("GovCarpeta rechaza (501): no deja al ciudadano y responde ok:false", async () => {
    govCarpeta.registerCitizen.mockRejectedValueOnce(Object.assign(new Error("501"), { response: { status: 501 } }));

    await handlers.registrarCiudadano(llegada());

    expect(await Citizen.countDocuments()).toBe(0);
    expect(published("transferencia.ciudadano_registrado")[0]).toMatchObject({ ok: false, motivo: "govcarpeta_rechazo_501" });
    expect(published("ciudadano.registrado")).toHaveLength(0);
  });

  test("respuesta ambigua de GovCarpeta: pregunta; si ya aparece afiliado, lo activa (no pierde un registro que si ocurrio)", async () => {
    govCarpeta.registerCitizen.mockRejectedValueOnce(new Error("socket hang up"));
    govCarpeta.validateCitizen.mockResolvedValueOnce({ available: false });

    await handlers.registrarCiudadano(llegada());

    expect((await Citizen.findById(NUEVO_ID).lean()).estado).toBe("activo");
    expect(published("transferencia.ciudadano_registrado")[0]).toMatchObject({ ok: true });
  });

  test("la cedula ya es de otro ciudadano de este operador -> ok:false, no toca al existente", async () => {
    await Citizen.create({ documento: 1000000001, nombre: "Otra", direccion: "x", correo: "o@b.co", passwordHash: "$argon2id$x", direccionUnica: "otra@carpetacolombia.co", estado: "activo" });

    await handlers.registrarCiudadano(llegada());

    expect(published("transferencia.ciudadano_registrado")[0]).toMatchObject({ ok: false, motivo: "ya_registrado_en_este_operador" });
    expect(govCarpeta.registerCitizen).not.toHaveBeenCalled();
  });

  test("la direccion unica ya la usa otro ciudadano -> ok:false (nunca se reasigna)", async () => {
    await Citizen.create({ documento: 2, nombre: "Otra", direccion: "x", correo: "o@b.co", passwordHash: "$argon2id$x", direccionUnica: DIR, estado: "activo" });
    await handlers.registrarCiudadano(llegada());
    expect(published("transferencia.ciudadano_registrado")[0]).toMatchObject({ ok: false, motivo: "direccion_unica_en_uso" });
  });

  test.each([["sin cedula", { documento: undefined }], ["correo invalido", { correo: "x" }], ["id invalido", { ciudadanoId: "abc" }]])("%s -> cola de fallidos", async (_c, extra) => {
    await expect(handlers.registrarCiudadano(llegada(extra))).rejects.toBeInstanceOf(PermanentError);
  });
});
