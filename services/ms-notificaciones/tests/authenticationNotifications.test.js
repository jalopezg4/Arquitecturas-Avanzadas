/**
 * HU-04, ola 6: ms-notificaciones avisa al ciudadano el resultado de la autenticacion (exito o fallo). Mismo
 * mecanismo idempotente que el resto de avisos; el eventId es por intento y resultado.
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
const DOC = "6ab68fddb64d2aa730b415bb";

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
const autenticado = (extra = {}) => ({ eventId: `${DOC}-auth-1-ok`, documentoId: DOC, ciudadanoId: ANA, titulo: "Diploma de grado", intento: 1, autenticadoEn: "2026-09-26T15:00:30.000Z", ...extra });
const fallida = (extra = {}) => ({ eventId: `${DOC}-auth-1-fallo`, documentoId: DOC, ciudadanoId: ANA, titulo: "Diploma de grado", intento: 1, motivo: "rechazado", fallidoEn: "2026-09-26T15:00:30.000Z", ...extra });

describe("documento.autenticado -> aviso de documento certificado", () => {
  test("envia UN correo con el titulo y la fecha de autenticacion", async () => {
    await withContact();

    await handlers.documentoAutenticado(autenticado());

    expect(sender.send).toHaveBeenCalledTimes(1);
    const mail = sender.send.mock.calls[0][0];
    expect(mail.to).toBe("ana@example.com");
    expect(mail.subject).toBe('Tu documento "Diploma de grado" ya esta certificado');
    expect(mail.text).toContain("Hola Ana Gomez");
    expect(mail.text).toContain("2026-09-26T15:00:30.000Z");
    expect(await Notification.findOne({ tipo: "documento_autenticado" }).lean()).toMatchObject({ estado: "enviado" });
  });

  test("el mismo evento repetido (tambien en paralelo) manda un solo correo", async () => {
    await withContact();

    await Promise.all(Array.from({ length: 5 }, () => handlers.documentoAutenticado(autenticado())));
    await handlers.documentoAutenticado(autenticado());

    expect(sender.send).toHaveBeenCalledTimes(1);
  });
});

describe("documento.autenticacion_fallida -> aviso de que no se pudo certificar", () => {
  test("rechazo: explica que sigue temporal y que puede reintentar o pedir el oficial", async () => {
    await withContact();

    await handlers.documentoAutenticacionFallida(fallida());

    const mail = sender.send.mock.calls[0][0];
    expect(mail.subject).toBe('No pudimos certificar tu documento "Diploma de grado"');
    expect(mail.text).toContain("no certificado (temporal)");
    expect(mail.text).toContain("no pudo autenticarlo");
  });

  test("centralizador caido: el texto dice que no respondio", async () => {
    await withContact();
    await handlers.documentoAutenticacionFallida(fallida({ motivo: "no_disponible" }));
    expect(sender.send.mock.calls[0][0].text).toContain("no respondio");
  });

  test("dos fallos del mismo documento en intentos distintos son DOS avisos (no un duplicado)", async () => {
    await withContact();

    await handlers.documentoAutenticacionFallida(fallida());
    await handlers.documentoAutenticacionFallida(fallida({ eventId: `${DOC}-auth-2-fallo`, intento: 2 }));

    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  test("un exito y un fallo del mismo documento no se confunden entre si", async () => {
    await withContact();

    await handlers.documentoAutenticacionFallida(fallida());
    await handlers.documentoAutenticado(autenticado({ eventId: `${DOC}-auth-2-ok`, intento: 2 }));

    expect(sender.send).toHaveBeenCalledTimes(2);
  });
});

describe("Mensajes que no se pueden procesar -> PermanentError", () => {
  test.each([
    ["sin eventId", { eventId: undefined }],
    ["ciudadanoId invalido", { ciudadanoId: "../x" }],
    ["titulo vacio", { titulo: " " }],
  ])("%s", async (_caso, extra) => {
    await withContact();
    await expect(handlers.documentoAutenticado(autenticado(extra))).rejects.toBeInstanceOf(PermanentError);
    await expect(handlers.documentoAutenticacionFallida(fallida(extra))).rejects.toBeInstanceOf(PermanentError);
    expect(sender.send).not.toHaveBeenCalled();
  });

  test("sin contacto del ciudadano no hay a quien escribir: PermanentError", async () => {
    await expect(handlers.documentoAutenticado(autenticado())).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("Seguridad de la plantilla", () => {
  test("un titulo con saltos de linea no inyecta encabezados en el asunto", async () => {
    await withContact();

    await handlers.documentoAutenticado(autenticado({ titulo: "Diploma\r\nBcc: atacante@example.com" }));

    expect(sender.send.mock.calls[0][0].subject).not.toMatch(/[\r\n]/);
  });
});
