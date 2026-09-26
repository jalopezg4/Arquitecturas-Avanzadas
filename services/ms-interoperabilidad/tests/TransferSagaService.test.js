/**
 * HU-05c, ola 3: saga del lado ORIGEN en ms-interoperabilidad, con Mongo en memoria y GovCarpeta, el operador
 * destino y el broker simulados. Nombres de los escenarios alineados con el issue #53.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Citizen = require("../src/domain/Citizen");
const Transfer = require("../src/domain/Transfer");
const AuditEntry = require("../src/domain/AuditEntry");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const { TransferRepository } = require("../src/infrastructure/TransferRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const SecretsManager = require("../src/security/SecretsManager");
const { TransferSagaService } = require("../src/application/TransferSagaService");
const TransferSweeper = require("../src/application/TransferSweeper");
const { SelfTransferError, NoTransferEndpointError } = require("../src/application/OperatorDirectoryService");
const { PeerOperatorClient, makeSafeLookup } = require("../src/infrastructure/PeerOperatorClient");

const SECRET = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const ANA = "6aae9153b7655900026073f1";
const DESTINO = "690d4e0e8502c8000221a5a7";
const CEDULA = 1000000001;
const DIRECCION_UNICA = "1000000001-3f9c2ab7@carpetacolombia.co";
const secrets = new SecretsManager({ active: SECRET });
const token = (sub = ANA) => secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: sub, expiresIn: 900 });

let mongoServer;
let clock;
let directory;
let govCarpeta;
let peer;
let publisher;
let saga;
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
  directory = { resolveTransferAddress: jest.fn(async () => ({ operatorId: DESTINO, name: "Operador Destino", transferApiUrl: "https://destino.example.co/api/transferCitizen" })) };
  govCarpeta = { unregisterCitizen: jest.fn(async () => ({ status: 201 })), registerCitizen: jest.fn(async () => ({ status: 201 })) };
  peer = { post: jest.fn(async () => ({ status: 200, data: "ok" })) };
  publisher = { publish: jest.fn(async () => {}) };
  const transferRepository = new TransferRepository();
  saga = new TransferSagaService({
    transferRepository,
    citizenRepository: new CitizenRepository(),
    directory,
    govCarpetaClient: govCarpeta,
    peerClient: peer,
    eventPublisher: publisher,
    auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
    publicBaseUrl: "https://mifolio.example.co/",
    confirmTimeoutMs: 5 * 60 * 1000,
    maxSendAttempts: 3,
    stepTimeoutMs: 2 * 60 * 1000,
    eventPublishTimeoutMs: 200,
    now: () => clock.now,
  });
  sweeper = new TransferSweeper({ transferRepository, reviewers: { saliente: saga }, now: () => clock.now });
  app = buildApp({ sagaService: saga, secrets, issuer: "ms-identidad" });
  await Citizen.create({ ciudadanoId: ANA, documento: CEDULA, nombre: "Ana Gomez", correo: "ana@example.com", direccionUnica: DIRECCION_UNICA, direccion: "Calle 1 # 2-3" });
});

const published = (rk) => publisher.publish.mock.calls.filter(([k]) => k === rk).map(([, p]) => p);
const exportados = [
  { documentoId: "d1", url: "https://files.mifolio.co/a.pdf?sig=1", titulo: "Diploma", entidadAvaladora: "EAFIT", fecha: "2026-03-15T00:00:00.000Z", estado: "certificado", sha256: "a".repeat(64) },
  { documentoId: "d2", url: "https://files.mifolio.co/b.pdf?sig=2", titulo: "Acta", entidadAvaladora: "EAFIT", fecha: "2026-03-15T00:00:00.000Z", estado: "temporal", sha256: "b".repeat(64) },
];
const advance = (ms) => {
  clock.now = new Date(clock.now.getTime() + ms);
};

/** Inicia por HTTP y simula la respuesta de ms-documentos: queda esperando la confirmacion del destino. */
async function iniciarYEnviar() {
  const res = await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(202);
  await saga.onFolderExported({ transferenciaId: res.body.transferenciaId, ok: true, documentos: exportados });
  const t = await Transfer.findById(res.body.transferenciaId).lean();
  const confirmUrl = new URL(peer.post.mock.calls[peer.post.mock.calls.length - 1][1].confirmAPI);
  return { id: res.body.transferenciaId, t, confirmToken: confirmUrl.searchParams.get("t") };
}
const confirmar = (body, tokenParam) => request(app).post(`/api/transferCitizenConfirm${tokenParam ? `?t=${tokenParam}` : ""}`).send(body);

describe("Escenario: transferencia exitosa", () => {
  test("POST /api/v1/transfers -> 202, registra la transferencia y ordena exportar la carpeta", async () => {
    const res = await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(202);

    expect(res.body).toMatchObject({ estado: "exportando", operadorDestino: "Operador Destino" });
    expect(published("transferencia.exportar_carpeta")).toEqual([{ transferenciaId: res.body.transferenciaId, ciudadanoId: ANA }]);
    expect(directory.resolveTransferAddress).toHaveBeenCalledWith(DESTINO);
  });

  test("con la carpeta exportada: desafilia en GovCarpeta y envia el protocolo acordado al destino (sin pasar por GovCarpeta)", async () => {
    const { t } = await iniciarYEnviar();

    expect(govCarpeta.unregisterCitizen).toHaveBeenCalledWith(CEDULA);
    expect(govCarpeta.unregisterCitizen.mock.invocationCallOrder[0]).toBeLessThan(peer.post.mock.invocationCallOrder[0]);
    const [url, body] = peer.post.mock.calls[0];
    expect(url).toBe("https://destino.example.co/api/transferCitizen");
    expect(body).toMatchObject({
      id: CEDULA,
      citizenName: "Ana Gomez",
      citizenEmail: "ana@example.com",
      urlDocuments: { URL1: [exportados[0].url], URL2: [exportados[1].url] },
      direccionUnica: DIRECCION_UNICA, // RF-10 (extension opcional)
      metadata: { URL1: { titulo: "Diploma", estado: "certificado" }, URL2: { titulo: "Acta", estado: "temporal" } },
    });
    expect(body.confirmAPI).toMatch(/^https:\/\/mifolio\.example\.co\/api\/transferCitizenConfirm\?t=[A-Za-z0-9_-]{16,}$/);
    expect(t).toMatchObject({ estado: "esperando_confirmacion", desafiliadoEnGovCarpeta: true, enviosRealizados: 1 });
  });

  test("confirmacion con req_status 1: publica ciudadano.transferido (borrado en origen) SOLO entonces y completa", async () => {
    const { id, confirmToken } = await iniciarYEnviar();
    expect(published("ciudadano.transferido")).toHaveLength(0); // nada se borra antes de la confirmacion

    const res = await confirmar({ id: CEDULA, req_status: 1 }, confirmToken).expect(200);

    expect(res.body).toEqual({ id: CEDULA, estado: "completada" });
    expect(published("ciudadano.transferido")).toEqual([{ transferenciaId: id, ciudadanoId: ANA, operadorDestinoId: DESTINO }]);
    expect(await Transfer.findById(id).lean()).toMatchObject({ estado: "completada", activa: false });
    expect(await Citizen.countDocuments({ ciudadanoId: ANA })).toBe(0);
  });

  test("GET /api/v1/citizens/me/transfer muestra la transferencia en curso", async () => {
    await iniciarYEnviar();
    const res = await request(app).get("/api/v1/citizens/me/transfer").set("Authorization", `Bearer ${token()}`).expect(200);
    expect(res.body).toMatchObject({ estado: "esperando_confirmacion", operadorDestino: "Operador Destino" });
  });
});

describe("Escenario: confirmacion duplicada (idempotencia)", () => {
  test("una segunda confirmacion con el mismo id responde 200 sin volver a borrar", async () => {
    const { confirmToken } = await iniciarYEnviar();

    await confirmar({ id: CEDULA, req_status: 1 }, confirmToken).expect(200);
    const res = await confirmar({ id: CEDULA, req_status: 1 }, confirmToken).expect(200);

    expect(res.body.estado).toBe("completada");
    expect(published("ciudadano.transferido")).toHaveLength(1);
  });

  test("dos confirmaciones SIMULTANEAS: un solo estado final completado", async () => {
    const { id, confirmToken } = await iniciarYEnviar();

    const codes = (await Promise.all([confirmar({ id: CEDULA, req_status: 1 }, confirmToken), confirmar({ id: CEDULA, req_status: 1 }, confirmToken)])).map((r) => r.status);

    expect(codes).toEqual([200, 200]);
    expect(await Transfer.countDocuments({ _id: id, estado: "completada" })).toBe(1);
  });
});

describe("Seguridad del confirmAPI", () => {
  test.each([
    ["sin token", undefined],
    ["token equivocado", "x".repeat(32)],
  ])("%s -> no se acepta y no se borra nada", async (_caso, tokenParam) => {
    await iniciarYEnviar();

    const res = await confirmar({ id: CEDULA, req_status: 1 }, tokenParam);

    expect([400, 404]).toContain(res.status);
    expect(published("ciudadano.transferido")).toHaveLength(0);
  });

  test("otra cedula con un token valido no confirma nada", async () => {
    const { confirmToken } = await iniciarYEnviar();
    await confirmar({ id: 999, req_status: 1 }, confirmToken).expect(404);
    expect(published("ciudadano.transferido")).toHaveLength(0);
  });

  test.each([[{ id: CEDULA, req_status: 2 }], [{ id: "abc", req_status: 1 }], [{ req_status: 1 }]])("cuerpo invalido %p -> 400", async (body) => {
    const { confirmToken } = await iniciarYEnviar();
    await confirmar(body, confirmToken).expect(400);
  });
});

describe("Escenario: el destino reporta fallo o no confirma (compensacion)", () => {
  test("req_status 0: re-afilia en GovCarpeta, desbloquea la carpeta y marca fallida", async () => {
    const { id, confirmToken } = await iniciarYEnviar();

    await confirmar({ id: CEDULA, req_status: 0 }, confirmToken).expect(200);

    expect(govCarpeta.registerCitizen).toHaveBeenCalledWith({ id: CEDULA, name: "Ana Gomez", address: "Calle 1 # 2-3", email: "ana@example.com" });
    expect(published("transferencia.cancelada")).toEqual([{ transferenciaId: id, ciudadanoId: ANA }]);
    expect(published("ciudadano.transferido")).toHaveLength(0);
    expect(await Transfer.findById(id).lean()).toMatchObject({ estado: "fallida", activa: false, reafiliado: true, motivo: "destino_reporto_fallo" });
  });

  test("timeout sin confirmacion: reenvia cada 5 min y, agotados los envios, falla, compensa y desbloquea", async () => {
    const { id } = await iniciarYEnviar();

    advance(5 * 60 * 1000 + 1);
    await sweeper.sweepOnce(); // envio 2
    advance(5 * 60 * 1000 + 1);
    await sweeper.sweepOnce(); // envio 3
    expect(peer.post).toHaveBeenCalledTimes(3);
    expect(govCarpeta.unregisterCitizen).toHaveBeenCalledTimes(1); // se desafilia UNA sola vez

    advance(5 * 60 * 1000 + 1);
    await sweeper.sweepOnce(); // agotado

    expect(await Transfer.findById(id).lean()).toMatchObject({ estado: "fallida", motivo: "sin_confirmacion_del_destino", reafiliado: true });
    expect(published("transferencia.cancelada")).toHaveLength(1);
  });

  test("antes del plazo el barrido no hace nada", async () => {
    await iniciarYEnviar();
    advance(60 * 1000);
    await sweeper.sweepOnce();
    expect(peer.post).toHaveBeenCalledTimes(1);
  });

  test("el destino rechaza definitivamente (4xx): compensa de inmediato", async () => {
    peer.post.mockRejectedValueOnce(Object.assign(new Error("400"), { definitive: true, status: 400 }));
    const res = await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(202);

    await saga.onFolderExported({ transferenciaId: res.body.transferenciaId, ok: true, documentos: [] });

    expect(await Transfer.findById(res.body.transferenciaId).lean()).toMatchObject({ estado: "fallida", reafiliado: true });
  });

  test("GovCarpeta no desafilia (caido): no se envia nada al destino y se reintenta despues", async () => {
    govCarpeta.unregisterCitizen.mockRejectedValueOnce(Object.assign(new Error("caido"), { code: "GOVCARPETA_UNAVAILABLE" }));
    const res = await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(202);

    await saga.onFolderExported({ transferenciaId: res.body.transferenciaId, ok: true, documentos: [] });
    expect(peer.post).not.toHaveBeenCalled();
    expect((await Transfer.findById(res.body.transferenciaId).lean()).estado).toBe("enviando");

    advance(61 * 1000);
    await sweeper.sweepOnce();
    expect(peer.post).toHaveBeenCalledTimes(1);
    expect((await Transfer.findById(res.body.transferenciaId).lean()).estado).toBe("esperando_confirmacion");
  });

  test("si no se habia desafiliado, compensar NO re-afilia (no hay nada que deshacer)", async () => {
    const res = await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(202);

    await saga.onFolderExported({ transferenciaId: res.body.transferenciaId, ok: false, motivo: "carpeta_en_otra_transferencia" });

    expect(govCarpeta.registerCitizen).not.toHaveBeenCalled();
    expect(await Transfer.findById(res.body.transferenciaId).lean()).toMatchObject({ estado: "fallida", motivo: "carpeta_en_otra_transferencia" });
  });

  test("si desbloquear la carpeta falla, queda 'fallando' y el barrido termina la compensacion", async () => {
    const { id, confirmToken } = await iniciarYEnviar();
    publisher.publish.mockImplementationOnce(async () => {
      throw new Error("broker caido");
    });

    await confirmar({ id: CEDULA, req_status: 0 }, confirmToken).expect(200);
    expect(await Transfer.findById(id).lean()).toMatchObject({ fallando: true, activa: true });

    advance(61 * 1000);
    await sweeper.sweepOnce();
    expect(await Transfer.findById(id).lean()).toMatchObject({ estado: "fallida", fallando: false });
    expect(govCarpeta.registerCitizen).toHaveBeenCalledTimes(1); // no re-afilia dos veces
  });
});

describe("Escenario: ms-documentos no responde a la exportacion", () => {
  test("el barrido repite la orden y, pasados 3 plazos, desiste sin tocar GovCarpeta", async () => {
    const res = await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(202);

    advance(2 * 60 * 1000 + 1);
    await sweeper.sweepOnce();
    expect(published("transferencia.exportar_carpeta")).toHaveLength(2);

    advance(5 * 60 * 1000);
    await sweeper.sweepOnce();
    expect(await Transfer.findById(res.body.transferenciaId).lean()).toMatchObject({ estado: "fallida", motivo: "exportacion_sin_respuesta" });
    expect(govCarpeta.unregisterCitizen).not.toHaveBeenCalled();
    expect(govCarpeta.registerCitizen).not.toHaveBeenCalled();
  });
});

describe("Validaciones al iniciar", () => {
  test("sin token -> 401; con operadorDestinoId invalido -> 400", async () => {
    await request(app).post("/api/v1/transfers").send({ operadorDestinoId: DESTINO }).expect(401);
    await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: "../x" }).expect(400);
  });

  test("una segunda transferencia mientras hay una en curso -> 409", async () => {
    await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(202);
    await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(409);
  });

  test("transferirse a este mismo operador -> 400; destino sin endpoint publicado -> 409", async () => {
    directory.resolveTransferAddress.mockRejectedValueOnce(new SelfTransferError());
    await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(400);
    directory.resolveTransferAddress.mockRejectedValueOnce(new NoTransferEndpointError());
    await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(409);
  });

  test("un ciudadano cuya copia local aun no llego -> 409 (no se inventan datos)", async () => {
    await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token("6aae9153b7655900026073ff")}`).send({ operadorDestinoId: DESTINO }).expect(409);
  });

  test("queda en la bitacora quien inicio la transferencia", async () => {
    await request(app).post("/api/v1/transfers").set("Authorization", `Bearer ${token()}`).send({ operadorDestinoId: DESTINO }).expect(202);
    expect(await AuditEntry.findOne({ action: "transferencia.iniciar" }).lean()).toMatchObject({ actor: ANA, actorType: "ciudadano", outcome: "exito" });
  });
});

describe("PeerOperatorClient (SSRF)", () => {
  test("rechaza una URL local o privada sin conectarse", async () => {
    const http = { post: jest.fn() };
    const client = new PeerOperatorClient({ http });
    await expect(client.post("http://127.0.0.1/api/transferCitizen", {})).rejects.toThrow();
    await expect(client.post("http://10.0.0.5/api/transferCitizen", {})).rejects.toThrow();
    expect(http.post).not.toHaveBeenCalled();
  });

  test("el lookup seguro rechaza un nombre que RESUELVE a una IP local (DNS rebinding)", (done) => {
    makeSafeLookup({ allowPrivate: false })("localhost", {}, (err) => {
      expect(err).toBeTruthy();
      expect(err.message).toMatch(/local o privada/);
      done();
    });
  });

  test("4xx del otro operador es definitivo; 5xx es transitorio", async () => {
    const client4 = new PeerOperatorClient({ http: { post: jest.fn(async () => ({ status: 422 })) } });
    await expect(client4.post("https://destino.example.co/api/transferCitizen", {})).rejects.toMatchObject({ definitive: true });
    const client5 = new PeerOperatorClient({ http: { post: jest.fn(async () => ({ status: 503 })) } });
    await expect(client5.post("https://destino.example.co/api/transferCitizen", {})).rejects.toMatchObject({ definitive: false });
  });
});
