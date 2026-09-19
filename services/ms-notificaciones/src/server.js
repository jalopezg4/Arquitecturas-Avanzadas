const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const Contact = require("./domain/Contact");
const Notification = require("./domain/Notification");
const { ContactRepository, NotificationRepository } = require("./infrastructure/Repositories");
const { createEmailSender } = require("./infrastructure/EmailSenders");
const { EventConsumer } = require("./infrastructure/EventConsumer");
const { NotificationService } = require("./application/NotificationService");
const makeEventHandlers = require("./interfaces/eventHandlers");

async function main() {
  await mongoose.connect(env.mongoUri);
  // Los indices UNICOS (un aviso por evento, un contacto por ciudadano) deben existir ANTES de consumir: sin ellos, dos
  // entregas simultaneas del mismo evento podrian mandar dos correos.
  await Promise.all([Contact.init(), Notification.init()]);

  const notificationService = new NotificationService({
    contactRepository: new ContactRepository(),
    notificationRepository: new NotificationRepository(),
    emailSender: createEmailSender(env.mail),
    operatorName: process.env.OPERATOR_NAME || "MiFolio",
    staleClaimMs: env.staleClaimMs,
  });
  const handlers = makeEventHandlers({ notificationService });

  // Colas que ya declaran los publicadores (ms-identidad y ms-documentos) para que los mensajes esperen aunque este
  // servicio no este corriendo: aqui se declaran IGUAL (solo durables) o el broker rechaza la redeclaracion.
  const consumers = [
    new EventConsumer({ uri: env.rabbitUri, queue: "ms-notificaciones.ciudadano-registrado", routingKey: "ciudadano.registrado", handler: handlers.ciudadanoRegistrado }),
    new EventConsumer({ uri: env.rabbitUri, queue: "ms-notificaciones.documento-cargado", routingKey: "documento.cargado", handler: handlers.documentoCargado }),
  ];
  // Si RabbitMQ no esta disponible al arrancar, el servicio NO cae: el consumidor reconecta solo.
  for (const consumer of consumers) {
    consumer.start().catch((err) => {
      logger.error("consumidor.arranque_fallido", { queue: consumer.queue, err });
      consumer._scheduleReconnect();
    });
  }

  const app = buildApp({ isReady: () => mongoose.connection.readyState === 1 && consumers.every((c) => Boolean(c.channel)) });
  app.listen(env.port, () => logger.info("ms-notificaciones escuchando", { port: env.port, transport: env.mail.transport }));
}

main().catch((err) => {
  logger.error("Fallo al iniciar ms-notificaciones", { err });
  process.exit(1);
});
