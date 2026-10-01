/**
 * HU-05c, ola 6: lado DESTINO en ms-interoperabilidad -- recibe `POST /api/transferCitizen`, coordina la importacion
 * (ms-documentos) y el registro (ms-identidad) y le confirma al origen en su confirmAPI.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Citizen = require("../src/domain/Citizen");
const Transfer = require("../src/domain/Transfer");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const { TransferRepository } = require("../src/infrastructure/TransferRepository");
const SecretsManager = require("../src/security/SecretsManager");
const { TransferReceiverService } = require("../src/application/TransferReceiverService");
const TransferSweeper = require("../src/application/TransferSweeper");
const { makeReceiverHandlers } = require("../src/interfaces/eventHandlers");

const CONFIRM = "https://origen.example.co/api/transferCitizenConfirm?t=abcdefghijklmnopqrstuvwx";
const secrets = new SecretsManager({ active: "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe" });

let mongoServer;
let clock;
let peer;
let publisher;
let receiver;
let handlers;
let sweeper;
let app;

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
  clock = { now: new Date("2026-09-26T15:00:00Z") };
  peer = { post: jest.fn(async () => ({ status: 200 })) };
  publisher = { publish: jest.fn(async () => {}) };
  const transferRepository = new TransferRepository();
  receiver = new TransferReceiverService({
    transferRepository,
    citizenRepository: new CitizenRepository(),
    peerClient: peer,
    eventPublisher: publisher,
    maxDocuments: 3,
    stepTimeoutMs: 2 * 60 * 1000,
    maxConfirmAttempts: 3,
    eventPublishTimeoutMs: 200,
    now: () => clock.now,
  });
  handlers = makeReceiverHandlers({ receiverService: receiver });
  sweeper = new TransferSweeper({ transferRepository, reviewers: { entrante: receiver }, now: () => clock.now });
  // sagaService falso: solo se prueban aqui las rutas del destino.
  app = buildApp({ sagaService: { initiate: jest.fn(), current: jest.fn(), confirm: jest.fn() }, receiverService: receiver, secrets, issuer: "ms-identidad" });
});

const pedido = (extra = {}) => ({
  id: 1032236578,
  citizenName: "Carlos Castro",
  citizenEmail: "myemail@example.com",
  urlDocuments: { URL1: ["https://origen.example.co/files/1.pdf"], URL2: ["https://origen.example.co/files/2.pdf"] },
  confirmAPI: CONFIRM,
  ...extra,
});
const published = (rk) => publisher.publish.mock.calls.filter(([k]) => k === rk).map(([, p]) => p);
const recibir = (body = pedido()) => request(app).post("/api/transferCitizen").send(body);
const advance = (ms) => {
  clock.now = new Date(clock.now.getTime() + ms);
};

describe("POST /api/transferCitizen (contrato acordado)", () => {
  test("202 y ordena a ms-documentos importar los documentos, con un id nuevo para el ciudadano", async () => {
    const res = await recibir().expect(202);

    const [orden] = published("transferencia.importar_documentos");
    expect(orden).toMatchObject({ transferenciaId: res.body.transferenciaId, documento: 1032236578 });
    expect(orden.ciudadanoId).toMatch(/^[0-9a-f]{24}$/);
    expect(orden.documentos.map((d) => [d.clave, d.url])).toEqual([
      ["URL1", "https://origen.example.co/files/1.pdf"],
      ["URL2", "https://origen.example.co/files/2.pdf"],
    ]);
  });

  test("acepta las extensiones opcionales (direccionUnica, citizenAddress, metadata) y un id como texto", async () => {
    await recibir(pedido({ id: "1032236578", direccionUnica: "1032236578-ab12cd34@carpetacolombia.co", citizenAddress: "Calle 9", metadata: { URL1: { titulo: "Diploma", estado: "certificado", sha256: "A".repeat(64) } } })).expect(202);

    const [orden] = published("transferencia.importar_documentos");
    expect(orden.direccionUnica).toBe("1032236578-ab12cd34@carpetacolombia.co");
    expect(orden.documentos[0]).toMatchObject({ titulo: "Diploma", estado: "certificado", sha256: "a".repeat(64) });
    expect(orden.documentos[1]).toMatchObject({ titulo: null, estado: null });
  });

  test("un reintento identico del origen no crea otra transferencia (misma respuesta)", async () => {
    const a = await recibir().expect(202);
    const b = await recibir().expect(202);

    expect(b.body.transferenciaId).toBe(a.body.transferenciaId);
    expect(await Transfer.countDocuments({ tipo: "entrante" })).toBe(1);
  });

  test("otro pedido distinto para la misma cedula mientras hay uno en curso -> 409", async () => {
    await recibir().expect(202);
    await recibir(pedido({ confirmAPI: "https://otro.example.co/api/transferCitizenConfirm" })).expect(409);
  });

  test("una cedula que ya es de un ciudadano de este operador -> 409", async () => {
    await Citizen.create({ ciudadanoId: "6aae9153b7655900026073f1", documento: 1032236578, nombre: "Carlos", correo: "c@x.co" });
    await recibir().expect(409);
  });

  test.each([
    ["confirmAPI hacia la red interna (SSRF)", { confirmAPI: "http://127.0.0.1:3004/api/transferCitizenConfirm" }],
    ["confirmAPI con credenciales", { confirmAPI: "https://u:p@origen.example.co/x" }],
    ["un documento en el servicio de metadatos de la nube", { urlDocuments: { URL1: ["http://169.254.169.254/latest"] } }],
    ["un documento con esquema file:", { urlDocuments: { URL1: ["file:///etc/passwd"] } }],
    ["id no numerico", { id: "abc" }],
    ["sin correo", { citizenEmail: undefined }],
    ["mas documentos que el tope", { urlDocuments: { A: ["https://o.example.co/1"], B: ["https://o.example.co/2"], C: ["https://o.example.co/3"], D: ["https://o.example.co/4"] } }],
  ])("%s -> 400 y no se ordena nada", async (_caso, extra) => {
    await recibir(pedido(extra)).expect(400);
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});

describe("Flujo completo del destino", () => {
  async function recibidaEImportada() {
    const res = await recibir().expect(202);
    const id = res.body.transferenciaId;
    await handlers.documentosImportados({ transferenciaId: id, ok: true, importados: 2 });
    return id;
  }

  test("documentos importados -> ordena a ms-identidad registrar; registrado -> confirma 1 al origen y completa", async () => {
    const id = await recibidaEImportada();
    const [registro] = published("transferencia.registrar_ciudadano");
    expect(registro).toMatchObject({ transferenciaId: id, documento: 1032236578, nombre: "Carlos Castro", correo: "myemail@example.com" });
    expect(peer.post).not.toHaveBeenCalled(); // no se confirma nada antes de tener al ciudadano completo

    await handlers.ciudadanoImportado({ transferenciaId: id, ok: true, direccionUnica: "1032236578-ab12cd34@carpetacolombia.co" });

    expect(peer.post).toHaveBeenCalledWith(CONFIRM, { id: 1032236578, req_status: 1 });
    expect(await Transfer.findById(id).lean()).toMatchObject({ estado: "completada", activa: false });
  });

  test("la importacion falla -> revierte y confirma 0 (el origen no debe borrar nada)", async () => {
    const res = await recibir().expect(202);
    await handlers.documentosImportados({ transferenciaId: res.body.transferenciaId, ok: false, motivo: "URL2: tipo de archivo no admitido" });

    expect(published("transferencia.revertir_importacion")).toHaveLength(1);
    expect(published("transferencia.registrar_ciudadano")).toHaveLength(0);
    expect(peer.post).toHaveBeenCalledWith(CONFIRM, { id: 1032236578, req_status: 0 });
    expect(await Transfer.findById(res.body.transferenciaId).lean()).toMatchObject({ estado: "rechazada" });
  });

  test("el registro en GovCarpeta falla -> revierte lo importado y confirma 0", async () => {
    const id = await recibidaEImportada();
    await handlers.ciudadanoImportado({ transferenciaId: id, ok: false, motivo: "govcarpeta_rechazo_501" });

    expect(published("transferencia.revertir_importacion")).toEqual([{ transferenciaId: id, ciudadanoId: expect.stringMatching(/^[0-9a-f]{24}$/) }]);
    expect(peer.post).toHaveBeenCalledWith(CONFIRM, { id: 1032236578, req_status: 0 });
  });

  test("respuestas repetidas o fuera de orden se ignoran (idempotencia)", async () => {
    const id = await recibidaEImportada();
    await handlers.documentosImportados({ transferenciaId: id, ok: true }); // repetida
    await handlers.ciudadanoImportado({ transferenciaId: id, ok: true });
    await handlers.ciudadanoImportado({ transferenciaId: id, ok: true }); // repetida

    expect(published("transferencia.registrar_ciudadano")).toHaveLength(1);
    expect(peer.post).toHaveBeenCalledTimes(1);
  });

  test("el confirmAPI del origen no responde: se reintenta desde el barrido y al final se desiste", async () => {
    peer.post.mockRejectedValue(new Error("ECONNREFUSED"));
    const id = await recibidaEImportada();
    await handlers.ciudadanoImportado({ transferenciaId: id, ok: true });
    expect((await Transfer.findById(id).lean()).estado).toBe("confirmando");

    advance(61 * 1000);
    await sweeper.sweepOnce();
    advance(61 * 1000);
    await sweeper.sweepOnce();

    expect(peer.post).toHaveBeenCalledTimes(3);
    expect(await Transfer.findById(id).lean()).toMatchObject({ estado: "completada", motivo: "origen_no_recibio_confirmacion" });
  });

  // Revision del PR #90: rechazar es una compensacion completa y nunca se hace con una copia vieja.
  test("el barrido con una copia vieja NO revierte una transferencia que el registro ya completo", async () => {
    const id = await recibidaEImportada();
    advance(6 * 60 * 1000 + 1); // vencido: el barrido la rechazaria
    const vieja = await Transfer.findById(id).lean();
    await handlers.ciudadanoImportado({ transferenciaId: id, ok: true }); // el registro llega justo antes

    expect(await receiver.review(vieja)).toEqual({ ignored: true });

    expect(published("transferencia.revertir_importacion")).toHaveLength(0);
    expect(published("transferencia.revertir_registro")).toHaveLength(0);
    expect(peer.post).toHaveBeenCalledWith(CONFIRM, { id: 1032236578, req_status: 1 });
    expect((await Transfer.findById(id).lean()).estado).toBe("completada");
  });

  test("al rechazar se compensa tambien el registro en ms-identidad", async () => {
    const id = await recibidaEImportada();
    advance(6 * 60 * 1000 + 1);
    await sweeper.sweepOnce(); // registrando_sin_respuesta

    expect(published("transferencia.revertir_registro")).toEqual([{ transferenciaId: id, ciudadanoId: expect.stringMatching(/^[0-9a-f]{24}$/), documento: 1032236578 }]);
    expect(await Transfer.findById(id).lean()).toMatchObject({ estado: "rechazada", reversionPendiente: false });
  });

  test("si el broker no publica la reversion, NO se confirma 0 todavia: el barrido la reintenta y luego confirma", async () => {
    const res = await recibir().expect(202);
    publisher.publish.mockRejectedValueOnce(new Error("broker caido"));

    await handlers.documentosImportados({ transferenciaId: res.body.transferenciaId, ok: false, motivo: "URL2 invalida" });
    expect(peer.post).not.toHaveBeenCalled();
    expect(await Transfer.findById(res.body.transferenciaId).lean()).toMatchObject({ estado: "confirmando", reversionPendiente: true });

    advance(61 * 1000);
    await sweeper.sweepOnce();

    expect(published("transferencia.revertir_registro")).toHaveLength(1);
    expect(peer.post).toHaveBeenCalledWith(CONFIRM, { id: 1032236578, req_status: 0 });
    expect((await Transfer.findById(res.body.transferenciaId).lean()).estado).toBe("rechazada");
  });

  test("el barrido con una copia vieja no repite la orden de importar de una transferencia ya rechazada", async () => {
    const res = await recibir().expect(202);
    advance(2 * 60 * 1000 + 1);
    const vieja = await Transfer.findById(res.body.transferenciaId).lean();
    await handlers.documentosImportados({ transferenciaId: res.body.transferenciaId, ok: false, motivo: "x" });

    expect(await receiver.review(vieja)).toEqual({ ignored: true });
    expect(published("transferencia.importar_documentos")).toHaveLength(1); // solo la original
  });

  test("un 429 del origen al confirmar no es definitivo: se reintenta despues de su Retry-After (acotado)", async () => {
    peer.post.mockRejectedValueOnce(Object.assign(new Error("429"), { status: 429, definitive: false, retryAfterMs: 90000 }));
    const id = await recibidaEImportada();
    await handlers.ciudadanoImportado({ transferenciaId: id, ok: true });

    const t = await Transfer.findById(id).lean();
    expect(t).toMatchObject({ estado: "confirmando", confirmacionesIntentadas: 1 });
    expect(t.revisarEn.getTime() - clock.now.getTime()).toBe(90000);
  });

  test("el origen reenvia la MISMA transferencia ya completada (no recibio la confirmacion): 202 y se le vuelve a confirmar 1", async () => {
    peer.post.mockRejectedValue(Object.assign(new Error("400"), { status: 400, definitive: true }));
    const id = await recibidaEImportada();
    await handlers.ciudadanoImportado({ transferenciaId: id, ok: true });
    expect(await Transfer.findById(id).lean()).toMatchObject({ estado: "completada", motivo: "origen_no_recibio_confirmacion" });
    await Citizen.create({ ciudadanoId: (await Transfer.findById(id).lean()).ciudadanoId, documento: 1032236578, nombre: "Carlos", correo: "c@x.co" });
    peer.post.mockReset().mockResolvedValue({ status: 200 });

    const res = await recibir().expect(202); // reenvio identico
    expect(res.body.transferenciaId).toBe(id);
    await sweeper.sweepOnce();

    expect(peer.post).toHaveBeenCalledWith(CONFIRM, { id: 1032236578, req_status: 1 });
    expect(await Transfer.findById(id).lean()).toMatchObject({ estado: "completada" });
    expect(await Transfer.countDocuments({ tipo: "entrante" })).toBe(1);
  });

  test("un pedido DISTINTO para un ciudadano que ya llego sigue siendo 409", async () => {
    const id = await recibidaEImportada();
    await handlers.ciudadanoImportado({ transferenciaId: id, ok: true });
    await Citizen.create({ ciudadanoId: (await Transfer.findById(id).lean()).ciudadanoId, documento: 1032236578, nombre: "Carlos", correo: "c@x.co" });

    await recibir(pedido({ urlDocuments: { URL1: ["https://origen.example.co/files/9.pdf"] } })).expect(409);
  });

  test("ms-documentos no responde: el barrido repite la orden y, pasado el plazo, rechaza y confirma 0", async () => {
    const res = await recibir().expect(202);

    advance(2 * 60 * 1000 + 1);
    await sweeper.sweepOnce();
    expect(published("transferencia.importar_documentos")).toHaveLength(2);

    advance(6 * 60 * 1000);
    await sweeper.sweepOnce();
    expect(peer.post).toHaveBeenCalledWith(CONFIRM, { id: 1032236578, req_status: 0 });
    expect((await Transfer.findById(res.body.transferenciaId).lean()).estado).toBe("rechazada");
  });
});
