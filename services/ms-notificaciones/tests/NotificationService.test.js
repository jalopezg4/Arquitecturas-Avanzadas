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
const EVENT_ID = "12d595a6-5827-45b5-a056-dd8a53711cd6";
const STALE_MS = 60000;

let mongoServer;
let sender;
let service;
let handlers;
let clock;

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
  await Promise.all([Contact.createIndexes(), Notification.createIndexes()]); // dropDatabase() borra los indices unicos
  clock = { now: new Date("2026-09-20T10:00:00Z") };
  sender = { send: jest.fn(async () => ({ messageId: "m1" })) };
  service = new NotificationService({ contactRepository: new ContactRepository(), notificationRepository: new NotificationRepository(), emailSender: sender, operatorName: "MiFolio", staleClaimMs: STALE_MS, now: () => clock.now });
  handlers = makeEventHandlers({ notificationService: service });
});

const registered = { ciudadanoId: ANA, documento: 1234567890, direccionUnica: "1234567890-ab12@carpetacolombia.co", nombre: "Ana Gomez", correo: "ana@example.com" };
const uploaded = (extra = {}) => ({ eventId: EVENT_ID, documentoId: "6aaea1c04c9de9c4c34f6b52", ciudadanoId: ANA, titulo: "Diploma de grado", entidadAvaladora: "Universidad EAFIT", estado: "temporal", cargadoEn: "2026-09-20T09:59:00.000Z", ...extra });
const withContact = () => handlers.ciudadanoRegistrado(registered).then(() => sender.send.mockClear());

describe("documento.cargado -> correo de confirmacion (RF-21)", () => {
  test("envia UN correo al ciudadano con el titulo, la entidad y el estado", async () => {
    await withContact();

    await handlers.documentoCargado(uploaded());

    expect(sender.send).toHaveBeenCalledTimes(1);
    const mail = sender.send.mock.calls[0][0];
    expect(mail.to).toBe("ana@example.com");
    expect(mail.subject).toBe('Tu documento "Diploma de grado" fue cargado en tu carpeta');
    expect(mail.text).toContain("Hola Ana Gomez");
    expect(mail.text).toContain("Universidad EAFIT");
    expect(mail.text).toContain("no certificado (temporal)");
  });

  test("queda registrado como enviado (asunto y estado, NUNCA el correo ni el cuerpo)", async () => {
    await withContact();
    await handlers.documentoCargado(uploaded());

    const n = await Notification.findOne({ eventKey: `documento.cargado:${EVENT_ID}` }).lean();
    expect(n).toMatchObject({ estado: "enviado", tipo: "documento_cargado", ciudadanoId: ANA, intentos: 1, asunto: 'Tu documento "Diploma de grado" fue cargado en tu carpeta' });
    expect(n.sentAt).toBeInstanceOf(Date);
    expect(JSON.stringify(n)).not.toContain("ana@example.com");
    expect(JSON.stringify(n)).not.toContain("Hola Ana");
  });

  test("IDEMPOTENTE: el mismo evento repetido no manda un segundo correo", async () => {
    await withContact();

    await handlers.documentoCargado(uploaded());
    await handlers.documentoCargado(uploaded());
    await handlers.documentoCargado(uploaded());

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(await Notification.countDocuments({ tipo: "documento_cargado" })).toBe(1);
  });

  test("CONCURRENCIA: 10 entregas SIMULTANEAS del mismo evento mandan exactamente 1 correo (reclamo atomico)", async () => {
    await withContact();
    sender.send.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30)); // un envio lento deja la ventana abierta a los demas
      return { messageId: "m" };
    });

    await Promise.all(Array.from({ length: 10 }, () => handlers.documentoCargado(uploaded())));

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect((await Notification.findOne({ eventKey: `documento.cargado:${EVENT_ID}` }).lean()).estado).toBe("enviado");
  });

  test("eventos DISTINTOS mandan correos distintos", async () => {
    await withContact();
    await handlers.documentoCargado(uploaded({ eventId: "evento-uno-0001" }));
    await handlers.documentoCargado(uploaded({ eventId: "evento-dos-0002" }));
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  test("un documento certificado se avisa como certificado", async () => {
    await withContact();
    await handlers.documentoCargado(uploaded({ estado: "certificado" }));
    expect(sender.send.mock.calls[0][0].text).toContain("Estado: certificado.");
  });
});

describe("fallos del envio: se reintenta sin duplicar", () => {
  test("si el correo falla, el error se PROPAGA (el consumidor reintenta) y el aviso queda 'fallido' con el motivo", async () => {
    await withContact();
    sender.send.mockRejectedValueOnce(new Error("smtp caido"));

    await expect(handlers.documentoCargado(uploaded())).rejects.toThrow("smtp caido");

    const n = await Notification.findOne({ eventKey: `documento.cargado:${EVENT_ID}` }).lean();
    expect(n).toMatchObject({ estado: "fallido", error: "smtp caido" });
    expect(n.sentAt).toBeNull();
  });

  test("al reentregarse el mensaje, el aviso fallido se RETOMA (un solo envio efectivo) y cuenta el intento", async () => {
    await withContact();
    sender.send.mockRejectedValueOnce(new Error("smtp caido"));
    await handlers.documentoCargado(uploaded()).catch(() => {});

    await handlers.documentoCargado(uploaded()); // reentrega

    const n = await Notification.findOne({ eventKey: `documento.cargado:${EVENT_ID}` }).lean();
    expect(n).toMatchObject({ estado: "enviado", intentos: 2, error: null });
    expect(sender.send).toHaveBeenCalledTimes(2); // 1 fallido + 1 exitoso, nunca 2 exitosos
    await handlers.documentoCargado(uploaded()); // y otra reentrega ya no manda nada
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  test("un aviso 'enviando' RECIENTE lo tiene otro proceso: no se duplica; uno ABANDONADO (mas viejo que el limite) se retoma", async () => {
    await withContact();
    await Notification.create({ eventKey: `documento.cargado:${EVENT_ID}`, tipo: "documento_cargado", ciudadanoId: ANA, estado: "enviando", intentos: 1, claimedAt: new Date(clock.now.getTime() - 5000) });

    await handlers.documentoCargado(uploaded()); // reclamo de hace 5 s: sigue en curso
    expect(sender.send).not.toHaveBeenCalled();

    clock.now = new Date(clock.now.getTime() + STALE_MS + 1000); // ahora el reclamo esta abandonado
    await handlers.documentoCargado(uploaded());
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect((await Notification.findOne({ eventKey: `documento.cargado:${EVENT_ID}` }).lean()).estado).toBe("enviado");
  });

  test("un aviso ya ENVIADO nunca se reclama de nuevo, aunque pase el tiempo", async () => {
    await withContact();
    await handlers.documentoCargado(uploaded());
    clock.now = new Date(clock.now.getTime() + 10 * STALE_MS);

    await handlers.documentoCargado(uploaded());

    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test("si el envio salio pero no se pudo marcar 'enviado', la reentrega NO duplica el correo", async () => {
    await withContact();
    const notifications = new NotificationRepository();
    notifications.markSent = jest.fn(async () => {
      throw new Error("mongo caido");
    });
    const flaky = new NotificationService({ contactRepository: new ContactRepository(), notificationRepository: notifications, emailSender: sender, staleClaimMs: STALE_MS, now: () => clock.now });

    await expect(flaky.onDocumentUploaded(uploaded())).rejects.toThrow("mongo caido");
    await flaky.onDocumentUploaded(uploaded()); // reentrega inmediata: el reclamo esta reciente

    expect(sender.send).toHaveBeenCalledTimes(1);
  });
});

describe("mensajes que NO se pueden procesar -> PermanentError (cola de fallidos, sin reintentar)", () => {
  test("documento.cargado de un ciudadano sin contacto (ciudadano.registrado no procesado): no se manda nada", async () => {
    await expect(handlers.documentoCargado(uploaded())).rejects.toThrow(PermanentError);
    expect(sender.send).not.toHaveBeenCalled();
    expect(await Notification.countDocuments()).toBe(0);
  });

  test.each([
    ["sin eventId (no habria idempotencia)", { eventId: undefined }],
    ["eventId con caracteres raros", { eventId: "a b/c" }],
    ["sin ciudadanoId", { ciudadanoId: undefined }],
    ["ciudadanoId con ../", { ciudadanoId: "../x" }],
    ["sin titulo", { titulo: "  " }],
    ["titulo enorme", { titulo: "x".repeat(301) }],
    ["sin entidad", { entidadAvaladora: undefined }],
  ])("documento.cargado %s", async (_name, override) => {
    await withContact();
    await expect(handlers.documentoCargado(uploaded(override))).rejects.toThrow(PermanentError);
    expect(sender.send).not.toHaveBeenCalled();
  });

  test.each([[null], ["texto"], [42]])("payload %j", async (payload) => {
    await expect(handlers.documentoCargado(payload)).rejects.toThrow(PermanentError);
    await expect(handlers.ciudadanoRegistrado(payload)).rejects.toThrow(PermanentError);
  });
});

describe("ciudadano.registrado -> contacto + bienvenida (HU-01)", () => {
  test("guarda a quien avisar y manda UNA bienvenida con la direccion institucional", async () => {
    await handlers.ciudadanoRegistrado(registered);

    expect(await Contact.findOne({ ciudadanoId: ANA }).lean()).toMatchObject({ nombre: "Ana Gomez", correo: "ana@example.com" });
    expect(sender.send).toHaveBeenCalledTimes(1);
    const mail = sender.send.mock.calls[0][0];
    expect(mail.subject).toBe("Bienvenida a MiFolio: tu carpeta ciudadana esta lista");
    expect(mail.text).toContain("1234567890-ab12@carpetacolombia.co");
    expect(mail.to).toBe("ana@example.com");
  });

  test("es idempotente y con entregas simultaneas: un contacto y una bienvenida", async () => {
    await Promise.all(Array.from({ length: 8 }, () => handlers.ciudadanoRegistrado(registered)));

    expect(await Contact.countDocuments({ ciudadanoId: ANA })).toBe(1);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test("actualiza el contacto si el correo cambia, sin volver a dar la bienvenida", async () => {
    await handlers.ciudadanoRegistrado(registered);
    await handlers.ciudadanoRegistrado({ ...registered, correo: "nuevo@example.com" });

    expect((await Contact.findOne({ ciudadanoId: ANA }).lean()).correo).toBe("nuevo@example.com");
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["sin nombre (evento anterior al enriquecimiento)", { nombre: undefined }],
    ["sin correo (evento anterior al enriquecimiento)", { correo: undefined }],
    ["correo invalido", { correo: "no-es-correo" }],
    ["correo con salto de linea (inyeccion de encabezados)", { correo: "a@b.co\r\nBcc: victima@x.co" }],
    ["correo con destinatarios multiples", { correo: "a@b.co, c@d.co" }],
    ["ciudadanoId invalido", { ciudadanoId: "../x" }],
  ])("%s -> PermanentError y no se manda nada", async (_name, override) => {
    await expect(handlers.ciudadanoRegistrado({ ...registered, ...override })).rejects.toThrow(PermanentError);
    expect(sender.send).not.toHaveBeenCalled();
    expect(await Contact.countDocuments()).toBe(0);
  });
});

describe("Seguridad de las plantillas (el texto viene de un ciudadano)", () => {
  test("un titulo con saltos de linea NO puede inyectar encabezados en el asunto", async () => {
    await withContact();

    await handlers.documentoCargado(uploaded({ titulo: "Diploma\r\nBcc: victima@example.com\r\nX-Evil: 1" }));

    const { subject } = sender.send.mock.calls[0][0];
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain("Diploma Bcc: victima@example.com X-Evil: 1"); // queda como texto inofensivo
  });

  test("el titulo se recorta a 120 caracteres en el asunto", async () => {
    await withContact();
    await handlers.documentoCargado(uploaded({ titulo: "T".repeat(250) }));
    expect(sender.send.mock.calls[0][0].subject).toBe(`Tu documento "${"T".repeat(120)}" fue cargado en tu carpeta`);
  });
});

describe("Logs: sin datos personales", () => {
  test("ningun log contiene el correo, el nombre ni el titulo", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));
    await handlers.ciudadanoRegistrado(registered);
    await handlers.documentoCargado(uploaded());
    sender.send.mockRejectedValueOnce(new Error("smtp caido"));
    await handlers.documentoCargado(uploaded({ eventId: "otro-evento-0003" })).catch(() => {});

    const dump = lines.join("\n");
    expect(dump).toContain("notificacion.enviada");
    expect(dump).toContain("notificacion.envio_fallido");
    for (const pii of ["ana@example.com", "Ana Gomez", "Diploma de grado", "Universidad EAFIT"]) expect(dump).not.toContain(pii);
  });
});
