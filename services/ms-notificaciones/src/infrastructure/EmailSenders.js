const nodemailer = require("nodemailer");
const logger = require("../tracing/logger");

/**
 * Puerto de salida de correo: send({to, subject, text}) -> Promise. La logica de negocio solo conoce esta forma,
 * asi que cambiar de proveedor (SMTP, un API de correo) no la toca.
 */

/** Desarrollo: NO envia nada. Deja constancia en el log (sin destinatario ni cuerpo) y el registro del aviso queda en Mongo. */
class ConsoleEmailSender {
  async send({ subject }) {
    logger.info("correo.simulado", { note: "EMAIL_TRANSPORT=console: no se envio nada", asuntoLongitud: subject.length });
    return { messageId: "console" };
  }
}

/** Envio real por SMTP con nodemailer. Cualquier fallo (red, autenticacion, rechazo) se propaga: el aviso se reintenta. */
class SmtpEmailSender {
  constructor({ smtp, from, transport }) {
    this.from = from;
    this.transporter =
      transport ||
      nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.security === "tls", // TLS implicito (465)
        requireTLS: smtp.security === "starttls", // 587: si el servidor no ofrece TLS, NO se envia en claro
        ignoreTLS: smtp.security === "none", // solo desarrollo local
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
        connectionTimeout: smtp.timeoutMs,
        greetingTimeout: smtp.timeoutMs,
        socketTimeout: smtp.timeoutMs,
        tls: { minVersion: "TLSv1.2" },
      });
  }

  async send({ to, subject, text }) {
    const info = await this.transporter.sendMail({ from: this.from, to, subject, text });
    if (info.rejected && info.rejected.length) throw new Error("el servidor SMTP rechazo al destinatario");
    return { messageId: info.messageId };
  }
}

function createEmailSender(mail) {
  return mail.transport === "smtp" ? new SmtpEmailSender({ smtp: mail.smtp, from: mail.from }) : new ConsoleEmailSender();
}

module.exports = { ConsoleEmailSender, SmtpEmailSender, createEmailSender };
