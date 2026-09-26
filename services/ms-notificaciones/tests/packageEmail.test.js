/**
 * HU-06.2 (RF-26): correo a una entidad EXTERNA con los enlaces temporales de un paquete documental.
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
const P1 = "6ab68fddb64d2aa730b41601";
const URL1 = "http://storage.test/ciudadanos/x/1.pdf?X-Amz-Signature=abc123&X-Amz-Expires=3600";

let mongoServer;
let sender;
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
  const service = new NotificationService({ contactRepository: new ContactRepository(), notificationRepository: new NotificationRepository(), emailSender: sender, smsSender: { send: jest.fn() }, operatorName: "MiFolio" });
  handlers = makeEventHandlers({ notificationService: service });
});

const envio = (extra = {}) => ({
  eventId: P1,
  paqueteId: P1,
  ciudadanoId: ANA,
  correo: "rrhh@empresa.co",
  nombreDestino: "Empresa X",
  remitenteDireccionUnica: "1000000001-ab12cd34@carpetacolombia.co",
  documentos: [{ titulo: "Diploma de grado", url: URL1 }],
  vencenEn: "2026-09-26T16:00:00.000Z",
  ...extra,
});

describe("paquete.envio_correo -> correo a la entidad externa", () => {
  test("envia UN correo al destinatario con cada documento, su enlace temporal y el vencimiento", async () => {
    await handlers.paqueteEnvioCorreo(envio());

    expect(sender.send).toHaveBeenCalledTimes(1);
    const mail = sender.send.mock.calls[0][0];
    expect(mail.to).toBe("rrhh@empresa.co");
    expect(mail.text).toContain("Hola Empresa X");
    expect(mail.text).toContain(`- Diploma de grado: ${URL1}`);
    expect(mail.text).toContain("1000000001-ab12cd34@carpetacolombia.co");
    expect(mail.text).toContain("2026-09-26T16:00:00.000Z");
  });

  test("no necesita un contacto registrado (el destinatario no es un ciudadano)", async () => {
    expect(await Contact.countDocuments()).toBe(0);
    await expect(handlers.paqueteEnvioCorreo(envio())).resolves.toBeUndefined();
  });

  test("el asunto no lleva enlaces, correo ni titulos (el asunto se guarda en la base)", async () => {
    await handlers.paqueteEnvioCorreo(envio());

    const { subject } = sender.send.mock.calls[0][0];
    expect(subject).not.toMatch(/http|rrhh@|Diploma/);
    const saved = await Notification.findOne({ tipo: "paquete_documental" }).lean();
    expect(saved).toMatchObject({ estado: "enviado", ciudadanoId: ANA });
    expect(JSON.stringify(saved)).not.toMatch(/X-Amz|rrhh@/);
  });

  test("el mismo evento repetido (tambien en paralelo) manda un solo correo", async () => {
    await Promise.all([handlers.paqueteEnvioCorreo(envio()), handlers.paqueteEnvioCorreo(envio()), handlers.paqueteEnvioCorreo(envio())]);
    await handlers.paqueteEnvioCorreo(envio());
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test("los logs no contienen el correo del destinatario, los enlaces ni los titulos", async () => {
    const lines = [];
    logger.setSink((line) => lines.push(line));

    await handlers.paqueteEnvioCorreo(envio());

    const all = lines.join("\n");
    expect(all).toContain("notificacion.enviada");
    expect(all).not.toMatch(/rrhh@empresa|X-Amz|Diploma de grado/);
  });

  test("un titulo con saltos de linea no rompe la plantilla", async () => {
    await handlers.paqueteEnvioCorreo(envio({ documentos: [{ titulo: "Diploma\r\nBcc: x@y.co", url: URL1 }] }));
    expect(sender.send.mock.calls[0][0].text).not.toContain("\r\nBcc");
  });
});

describe("Mensajes que no se pueden procesar -> PermanentError", () => {
  test.each([
    ["varios destinatarios", { correo: "a@b.co,c@d.co" }],
    ["destinatario con punto y coma", { correo: "a@b.co;c@d.co" }],
    ["sin documentos", { documentos: [] }],
    ["url que no es http(s)", { documentos: [{ titulo: "x", url: "javascript:alert(1)" }] }],
    ["sin eventId", { eventId: undefined }],
  ])("%s", async (_caso, extra) => {
    await expect(handlers.paqueteEnvioCorreo(envio(extra))).rejects.toBeInstanceOf(PermanentError);
    expect(sender.send).not.toHaveBeenCalled();
  });
});
