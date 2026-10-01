/**
 * HU-05c (revision del PR #90): si la transferencia a otro operador se cancela, el ciudadano recibe un correo con el
 * motivo y la tranquilidad de que sus datos siguen aqui. Un aviso por transferencia, aunque el evento se repita.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Contact = require("../src/domain/Contact");
const Notification = require("../src/domain/Notification");
const { ContactRepository, NotificationRepository } = require("../src/infrastructure/Repositories");
const { PermanentError } = require("../src/infrastructure/EventConsumer");
const logger = require("../src/tracing/logger");
const makeEventHandlers = require("../src/interfaces/eventHandlers");
const { NotificationService } = require("../src/application/NotificationService");

const ANA = "6aae9153b7655900026073f1";

let mongoServer;
let sender;
let service;
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
  logger.resetSink();
  await mongoose.connection.dropDatabase();
});
beforeEach(async () => {
  await Promise.all([Contact.createIndexes(), Notification.createIndexes()]);
  sender = { send: jest.fn(async () => ({ messageId: "m1" })) };
  service = new NotificationService({
    contactRepository: new ContactRepository(),
    notificationRepository: new NotificationRepository(),
    emailSender: sender,
    smsSender: { send: jest.fn() },
    operatorName: "MiFolio",
    now: () => new Date("2026-09-26T15:01:00Z"),
  });
  handlers = makeEventHandlers({ notificationService: service });
});

const withContact = () =>
  handlers.ciudadanoRegistrado({ ciudadanoId: ANA, documento: 1000000001, nombre: "Ana Gomez", correo: "ana@example.com" }).then(() => sender.send.mockClear());

const T1 = "6ab68fddb64d2aa730b41501";
const cancelada = (extra = {}) => ({ transferenciaId: T1, ciudadanoId: ANA, motivo: "demasiados_documentos", operadorDestino: "Operador Destino", ...extra });

describe("transferencia.cancelada -> aviso al ciudadano", () => {
  test("envia UN correo con el motivo en palabras y que sus datos siguen aqui; repetido no reenvia", async () => {
    await withContact();

    await handlers.transferenciaCancelada(cancelada());
    await handlers.transferenciaCancelada(cancelada());

    expect(sender.send).toHaveBeenCalledTimes(1);
    const { to, subject, text } = sender.send.mock.calls[0][0];
    expect(to).toBe("ana@example.com");
    expect(subject).toBe("Tu traslado de operador no se completo");
    expect(text).toContain("traslado a Operador Destino no se pudo completar");
    expect(text).toContain("maximo 500");
    expect(text).toContain("siguen en tu carpeta");
  });

  test.each([
    ["destino_no_recibio_reintentos_agotados", "no respondio"],
    ["destino_reporto_fallo", "no pudo recibir tus datos"],
    ["algo_nuevo", "Puedes intentarlo de nuevo"],
  ])("motivo %s -> '%s'", async (motivo, frase) => {
    await withContact();
    await handlers.transferenciaCancelada(cancelada({ motivo }));
    expect(sender.send.mock.calls[0][0].text).toContain(frase);
  });

  test("sin operador ni motivo tambien avisa", async () => {
    await withContact();
    await handlers.transferenciaCancelada({ transferenciaId: T1, ciudadanoId: ANA });
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test("mensaje mal formado -> cola de fallidos", async () => {
    await expect(handlers.transferenciaCancelada({ transferenciaId: "../x", ciudadanoId: ANA })).rejects.toBeInstanceOf(PermanentError);
    await expect(handlers.transferenciaCancelada(cancelada({ motivo: "x".repeat(201) }))).rejects.toBeInstanceOf(PermanentError);
  });
});
