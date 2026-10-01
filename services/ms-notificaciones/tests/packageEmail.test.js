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

describe("solicitud_oficial.pendiente (HU-06.4) -> aviso a la entidad emisora", () => {
  const aviso = (extra = {}) => ({ eventId: P1, solicitudOficialId: P1, ciudadanoId: ANA, correo: "registro@eafit.edu.co", nombreEntidad: "Universidad EAFIT", tituloDocumento: "Acta de grado", descripcion: "La original", remitenteDireccionUnica: "1-ab@carpetacolombia.co", ...extra });

  test("envia UN correo a la entidad con el documento pedido y como atenderlo; repetido no se reenvia", async () => {
    await handlers.solicitudOficialPendiente(aviso());
    await handlers.solicitudOficialPendiente(aviso());

    expect(sender.send).toHaveBeenCalledTimes(1);
    const mail = sender.send.mock.calls[0][0];
    expect(mail.to).toBe("registro@eafit.edu.co");
    expect(mail.subject).not.toMatch(/Acta|eafit/);
    expect(mail.text).toContain("Hola Universidad EAFIT");
    expect(mail.text).toContain("Acta de grado");
    expect(mail.text).toContain("/api/v1/official-requests");
  });

  test.each([["varios destinatarios", { correo: "a@b.co,c@d.co" }], ["sin titulo", { tituloDocumento: "" }]])("%s -> cola de fallidos", async (_c, extra) => {
    await expect(handlers.solicitudOficialPendiente(aviso(extra))).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("ciudadano.activacion_requerida (HU-05c) -> codigo de activacion", () => {
  const CODIGO = "Zq8mV2nX9pLr5tYc7bW1kD4hJ6fG3sAuQw0eRtYuIo1";
  const evento = (extra = {}) => ({ eventId: `${ANA}-act-1790000000000`, ciudadanoId: ANA, nombre: "Ana Gomez", correo: "ana@example.com", codigo: CODIGO, venceEn: "2026-09-29T15:00:00.000Z", ...extra });

  test("envia el codigo en el CUERPO (no en el asunto, que se guarda) y no lo deja en los logs; no requiere contacto previo", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(l));

    await handlers.activacionRequerida(evento());
    await handlers.activacionRequerida(evento()); // repetido: un solo correo

    expect(sender.send).toHaveBeenCalledTimes(1);
    const mail = sender.send.mock.calls[0][0];
    expect(mail.to).toBe("ana@example.com");
    expect(mail.text).toContain(CODIGO);
    expect(mail.text).toContain("/api/v1/auth/activate");
    expect(mail.subject).not.toContain(CODIGO);
    expect(JSON.stringify(await Notification.findOne({ tipo: "activacion_cuenta" }).lean())).not.toContain(CODIGO);
    expect(lines.join("\n")).not.toContain(CODIGO);
  });

  test.each([["codigo con forma invalida", { codigo: "corto" }], ["varios destinatarios", { correo: "a@b.co,c@d.co" }]])("%s -> cola de fallidos", async (_c, extra) => {
    await expect(handlers.activacionRequerida(evento(extra))).rejects.toBeInstanceOf(PermanentError);
  });
});

