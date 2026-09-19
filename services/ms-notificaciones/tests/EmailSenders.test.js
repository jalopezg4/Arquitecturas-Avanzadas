const net = require("net");
const { SMTPServer } = require("smtp-server");
const { SmtpEmailSender, ConsoleEmailSender, createEmailSender } = require("../src/infrastructure/EmailSenders");
const logger = require("../src/tracing/logger");

/** Servidor SMTP REAL en un puerto efimero: guarda lo que recibe y permite simular rechazos. */
async function startSmtp({ user = "svc", pass = "clave-de-prueba-1", rejectRcpt = false, starttls = false } = {}) {
  const received = [];
  const server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true, // solo pruebas locales: sin TLS no se aceptaria AUTH
    disabledCommands: starttls ? [] : ["STARTTLS"],
    logger: false,
    onAuth(auth, _session, cb) {
      return auth.username === user && auth.password === pass ? cb(null, { user: auth.username }) : cb(new Error("credenciales invalidas"));
    },
    onRcptTo(address, _session, cb) {
      return rejectRcpt ? cb(new Error("destinatario no permitido")) : cb();
    },
    onData(stream, _session, cb) {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"));
        cb();
      });
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { received, port: server.server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** Decodifica el encabezado Subject como lo haria un cliente de correo (RFC 2047, Q-encoding en UTF-8). */
function decodedSubject(raw) {
  const line = /^Subject: (.*)$/m.exec(raw)[1];
  return line.replace(/=\?UTF-8\?Q\?(.*?)\?=/g, (_m, q) => decodeURIComponent(q.replace(/_/g, " ").replace(/=([0-9A-F]{2})/g, "%$1")));
}

const smtpConfig = (port, extra = {}) => ({ host: "127.0.0.1", port, user: "svc", pass: "clave-de-prueba-1", security: "none", timeoutMs: 3000, ...extra });
const sender = (port, extra) => new SmtpEmailSender({ smtp: smtpConfig(port, extra), from: "no-responder@carpetacolombia.co" });
const mail = { to: "ana@example.com", subject: 'Tu documento "Diploma" fue cargado', text: "Hola Ana,\n\nTu documento se cargo." };

describe("SmtpEmailSender (contra un servidor SMTP real)", () => {
  let smtp;
  afterEach(async () => {
    if (smtp) await smtp.close();
    smtp = null;
  });

  test("entrega el correo con remitente, destinatario, asunto y cuerpo", async () => {
    smtp = await startSmtp();

    const res = await sender(smtp.port).send(mail);

    expect(res.messageId).toBeTruthy();
    expect(smtp.received).toHaveLength(1);
    const raw = smtp.received[0];
    expect(raw).toMatch(/^From: no-responder@carpetacolombia\.co/m);
    expect(raw).toMatch(/^To: ana@example\.com/m);
    expect(decodedSubject(raw)).toBe('Tu documento "Diploma" fue cargado');
    expect(raw).toContain("Tu documento se cargo.");
  });

  test("contrasena SMTP incorrecta -> falla (el aviso se reintenta) y no se entrega nada", async () => {
    smtp = await startSmtp();

    await expect(sender(smtp.port, { pass: "otra-clave-equivocada" }).send(mail)).rejects.toThrow();

    expect(smtp.received).toHaveLength(0);
  });

  test("destinatario rechazado por el servidor -> falla", async () => {
    smtp = await startSmtp({ rejectRcpt: true });

    await expect(sender(smtp.port).send(mail)).rejects.toThrow();
    expect(smtp.received).toHaveLength(0);
  });

  test("servidor caido (puerto cerrado) -> falla rapido, no se cuelga", async () => {
    const started = Date.now();
    await expect(sender(1).send(mail)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("servidor que acepta la conexion y NO responde -> se rinde en el plazo configurado, no espera para siempre", async () => {
    const sockets = new Set();
    const hole = net.createServer((s) => {
      sockets.add(s);
      s.on("error", () => {});
    });
    await new Promise((r) => hole.listen(0, "127.0.0.1", r));
    try {
      const started = Date.now();
      await expect(sender(hole.address().port, { timeoutMs: 400 }).send(mail)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      sockets.forEach((s) => s.destroy());
      await new Promise((r) => hole.close(r));
    }
  }, 15000);

  test("con SMTP_SECURITY=starttls y un servidor SIN TLS, NO se envia en claro (ni las credenciales ni el correo)", async () => {
    smtp = await startSmtp({ starttls: false });

    await expect(sender(smtp.port, { security: "starttls" }).send(mail)).rejects.toThrow();

    expect(smtp.received).toHaveLength(0);
  });

  test("un asunto con saltos de linea NO logra agregar encabezados (nodemailer los neutraliza)", async () => {
    smtp = await startSmtp();

    await sender(smtp.port).send({ ...mail, subject: "Hola\r\nBcc: victima@example.com" });

    const headers = smtp.received[0].split(/\r?\n\r?\n/)[0];
    expect(headers).not.toMatch(/^Bcc:/m);
  });
});

describe("Transporte console (desarrollo)", () => {
  test("no envia nada y NO registra destinatario, asunto ni cuerpo", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));

    const res = await new ConsoleEmailSender().send({ to: "ana@example.com", subject: "Asunto secreto", text: "cuerpo" });
    logger.resetSink();

    expect(res.messageId).toBe("console");
    const dump = lines.join("\n");
    expect(dump).toContain("correo.simulado");
    for (const pii of ["ana@example.com", "Asunto secreto", "cuerpo"]) expect(dump).not.toContain(pii);
  });
});

describe("createEmailSender()", () => {
  test("elige el transporte segun la configuracion", () => {
    expect(createEmailSender({ transport: "console" })).toBeInstanceOf(ConsoleEmailSender);
    expect(createEmailSender({ transport: "smtp", from: "a@b.co", smtp: smtpConfig(2525) })).toBeInstanceOf(SmtpEmailSender);
  });
});
