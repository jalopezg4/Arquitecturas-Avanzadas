require("dotenv").config();
const { assertValidConfig, ConfigError } = require("./ConfigValidator");

// Falla cerrado, igual que los demas servicios: sin NODE_ENV no se asume desarrollo.
if (!process.env.NODE_ENV) {
  throw new ConfigError(["NODE_ENV es obligatorio: development, test, staging o production"]);
}
const nodeEnv = process.env.NODE_ENV;
const isLocal = nodeEnv === "development" || nodeEnv === "test";

const toInt = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

const config = {
  nodeEnv,
  isLocal,
  port: process.env.PORT || 3003,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/ms-notificaciones",
  rabbitUri: process.env.RABBITMQ_URI || "amqp://localhost:5672",
  mail: {
    // console: no envia nada, solo deja constancia en la base (desarrollo). smtp: envio real (obligatorio fuera de local).
    transport: process.env.EMAIL_TRANSPORT || (isLocal ? "console" : "smtp"),
    from: process.env.MAIL_FROM || "no-responder@carpetacolombia.co",
    smtp: {
      host: process.env.SMTP_HOST || "",
      port: toInt(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
      // tls = TLS implicito (465); starttls = se exige actualizar a TLS (587); none = sin cifrar (solo local, p. ej. MailHog)
      security: process.env.SMTP_SECURITY || "starttls",
      timeoutMs: toInt(process.env.SMTP_TIMEOUT_MS, 8000),
    },
  },
  // HU-06.3 (RF-28), Paso 3.3-A: SMS best-effort. Sin proveedor real todavia, unico valor valido es "console".
  sms: {
    transport: process.env.SMS_TRANSPORT || "console",
  },
  // Un aviso "en proceso" mas viejo que esto se considera abandonado (el proceso murio a medias) y otro lo retoma.
  staleClaimMs: toInt(process.env.NOTIFICATION_STALE_CLAIM_MS, 60000),
};

assertValidConfig(config);

module.exports = config;
