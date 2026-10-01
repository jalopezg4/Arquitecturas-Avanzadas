/**
 * HT-05 (RNF-11): suite de contrato del protocolo de transferencia. Se corre contra:
 *   - el operador de REFERENCIA (debe cumplir el 100% de los casos obligatorios);
 *   - operadores que NO cumplen (la suite debe fallar explicitamente, diciendo que caso y por que);
 *   - NUESTRA propia implementacion (ms-interoperabilidad, HU-05c), con sus servicios internos simulados.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Citizen = require("../src/domain/Citizen");
const Transfer = require("../src/domain/Transfer");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const { TransferRepository } = require("../src/infrastructure/TransferRepository");
const { PeerOperatorClient } = require("../src/infrastructure/PeerOperatorClient");
const SecretsManager = require("../src/security/SecretsManager");
const { TransferReceiverService, IMPORTAR, REGISTRAR } = require("../src/application/TransferReceiverService");
const { TransferSagaService } = require("../src/application/TransferSagaService");
const { ContractTestSuite, formatReport } = require("../src/contract/ContractTestSuite");
const { createReferenceOperator } = require("../src/contract/ReferenceOperator");
const { validateTransferCitizen, validateConfirm } = require("../src/contract/protocol");

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}
const runSuite = (targetBaseUrl) => new ContractTestSuite({ targetBaseUrl, confirmTimeoutMs: 3000, requestTimeoutMs: 3000 }).run();
const failed = (report) => report.casos.filter((c) => c.obligatorio && !c.ok).map((c) => c.nombre);

describe("protocol.js: el contrato como validadores", () => {
  const valido = { id: 1032236578, citizenName: "Carlos Castro", citizenEmail: "myemail@example.com", urlDocuments: { URL1: ["http://example.com/document1"] }, confirmAPI: "http://x.co/api/transferCitizenConfirm" };

  test("el ejemplo del protocolo acordado es valido", () => {
    expect(validateTransferCitizen(valido)).toEqual([]);
    expect(validateConfirm({ id: 1032236578, req_status: 1 })).toEqual([]);
  });

  test.each([
    [{ ...valido, id: "1032236578" }, /id debe ser un numero/],
    [{ ...valido, urlDocuments: { URL1: "http://example.com/d" } }, /lista no vacia/],
    [{ ...valido, confirmAPI: undefined }, /confirmAPI/],
  ])("detecta incumplimientos del transferCitizen (%#)", (body, re) => {
    expect(validateTransferCitizen(body).join()).toMatch(re);
  });

  test.each([
    [{ id: 1, req_status: "completado" }, /req_status debe ser el numero 1/], // lo que decia el issue #53
    [{ id: 1, req_status: true }, /req_status/],
    [{ id: "1", req_status: 1 }, /id debe ser un numero/],
    [{ id: 2, req_status: 1 }, /id debe ser el del ciudadano transferido/],
  ])("detecta incumplimientos de la confirmacion (%#)", (body, re) => {
    expect(validateConfirm(body, { expectedId: 1 }).join()).toMatch(re);
  });
});

describe("Escenario: contrato valido con operador de referencia", () => {
  test("el 100% de los casos obligatorios se completa (RNF-11)", async () => {
    const ref = await listen(createReferenceOperator().app);
    try {
      const report = await runSuite(ref.url);
      expect(failed(report)).toEqual([]);
      expect(report).toMatchObject({ cumple: true });
      expect(report.obligatorios.total).toBeGreaterThanOrEqual(6);
      expect(report.casos.every((c) => c.ok)).toBe(true); // el de referencia cumple tambien los recomendados
    } finally {
      await ref.close();
    }
  });
});

describe("Escenario: deteccion de incumplimiento de contrato", () => {
  test.each([
    ["confirma con req_status 'completado' (el formato viejo del issue #53)", { confirmBody: (b) => ({ id: b.id, req_status: "completado" }) }, "la confirmacion cumple {id: number, req_status: 1|0}"],
    ["confirma con el id como texto", { confirmBody: (b) => ({ id: String(b.id), req_status: 1 }) }, "la confirmacion cumple {id: number, req_status: 1|0}"],
    ["nunca llama al confirmAPI", { neverConfirm: true }, "confirma en el confirmAPI recibido (en menos de 3000 ms)"],
    ["responde 500 al transferCitizen", { transferStatus: 500 }, "transferCitizen acepta un pedido valido (2xx)"],
  ])("un operador que %s NO cumple, y el reporte dice por que", async (_caso, behavior, casoEsperado) => {
    const bad = await listen(createReferenceOperator({ behavior }).app);
    try {
      const report = await runSuite(bad.url);
      expect(report.cumple).toBe(false);
      expect(failed(report)).toContain(casoEsperado);
      expect(formatReport(report)).toContain(`[FALLA] ${casoEsperado}`);
    } finally {
      await bad.close();
    }
  });

  test("un operador inalcanzable no cumple (sin colgarse)", async () => {
    const report = await new ContractTestSuite({ targetBaseUrl: "http://127.0.0.1:9", confirmTimeoutMs: 500, requestTimeoutMs: 1000 }).run();
    expect(report.cumple).toBe(false);
  });
});

describe("Nuestra implementacion (HU-05c) cumple el contrato", () => {
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
    await Promise.all([Citizen.createIndexes(), Transfer.createIndexes()]);
  });

  test("como DESTINO: recibe, importa, registra y confirma segun el protocolo (servicios internos simulados)", async () => {
    let receiver;
    // ms-documentos (descarga de verdad las URLs) y ms-identidad simulados sobre el bus.
    const publisher = {
      publish: jest.fn(async (routingKey, payload) => {
        setImmediate(async () => {
          if (routingKey === IMPORTAR) {
            let ok = true;
            for (const d of payload.documentos) ok = ok && (await fetch(d.url)).ok;
            await receiver.onDocumentsImported({ transferenciaId: payload.transferenciaId, ok });
          } else if (routingKey === REGISTRAR) {
            await receiver.onCitizenRegistered({ transferenciaId: payload.transferenciaId, ok: true });
          }
        });
      }),
    };
    receiver = new TransferReceiverService({
      transferRepository: new TransferRepository(),
      citizenRepository: new CitizenRepository(),
      peerClient: new PeerOperatorClient({ allowPrivate: true }), // la suite corre en localhost
      eventPublisher: publisher,
      urlPolicy: { allowPrivate: true },
      eventPublishTimeoutMs: 1000,
    });
    const app = buildApp({ sagaService: { initiate: jest.fn(), current: jest.fn(), confirm: jest.fn(async () => { throw new Error("no aplica"); }) }, receiverService: receiver, secrets: new SecretsManager({ active: "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe" }) });
    const ours = await listen(app);
    try {
      const report = await runSuite(ours.url);
      expect(failed(report)).toEqual([]);
      expect(report.cumple).toBe(true);
    } finally {
      await ours.close();
    }
  });

  test("como ORIGEN: el transferCitizen que enviamos cumple el contrato (con sus extensiones opcionales)", () => {
    const saga = new TransferSagaService({ publicBaseUrl: "https://mifolio.example.co" });
    const body = saga._body({
      documento: 1000000001,
      nombre: "Ana Gomez",
      correo: "ana@example.com",
      direccionUnica: "1000000001-ab12cd34@carpetacolombia.co",
      direccion: "Calle 1",
      confirmToken: "abcdefghijklmnopqrstuvwx",
      documentos: [{ clave: "URL1", url: "https://files.mifolio.co/a.pdf?sig=1", titulo: "Diploma", estado: "certificado" }],
    });
    expect(validateTransferCitizen(body)).toEqual([]);
  });
});
