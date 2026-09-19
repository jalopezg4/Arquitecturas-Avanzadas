const amqp = require("amqplib");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

const EXCHANGE = "carpeta-ciudadana.events";

// ms-documentos y ms-notificaciones aun no existen como servicios corriendo (siguientes
// HU en el plan de trabajo), pero el evento que ms-identidad publica en HU-01 es para
// ellos. Sin una cola ligada al topic exchange, RabbitMQ descarta el mensaje al no haber
// nadie suscrito -- por eso se pre-declaran aqui las colas que esos servicios usaran,
// durables y ligadas a la routing key, para que los mensajes queden esperando en cola
// hasta que esos consumidores existan. Declarar una cola es idempotente: cuando
// ms-documentos/ms-notificaciones se implementen y declaren la misma cola, no se duplica.
const ANTICIPATED_BINDINGS = [
  { queue: "ms-documentos.ciudadano-registrado", routingKey: "ciudadano.registrado" },
  { queue: "ms-notificaciones.ciudadano-registrado", routingKey: "ciudadano.registrado" },
];

class EventPublisher {
  constructor(rabbitUri) {
    this.rabbitUri = rabbitUri;
    this.channel = null;
  }

  async connect() {
    const conn = await amqp.connect(this.rabbitUri);
    // Canal confirmable: publish() solo resuelve cuando el broker confirma que aceptó
    // (y, al ser `persistent`, persistió) el mensaje -- no basta con que el buffer local
    // lo haya aceptado para escribir en el socket.
    this.channel = await conn.createConfirmChannel();
    await this.channel.assertExchange(EXCHANGE, "topic", { durable: true });

    for (const { queue, routingKey } of ANTICIPATED_BINDINGS) {
      await this.channel.assertQueue(queue, { durable: true });
      await this.channel.bindQueue(queue, EXCHANGE, routingKey);
    }
  }

  /**
   * Publica un evento; el mensaje es JSON persistente (ADR-04).
   * Devuelve una promesa que solo resuelve cuando el broker confirma la entrega/persistencia;
   * si el broker rechaza (nack) o la conexion cae antes de confirmar, rechaza la promesa.
   */
  async publish(routingKey, payload) {
    if (!this.channel) await this.connect();
    return new Promise((resolve, reject) => {
      this.channel.publish(
        EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        {
          persistent: true,
          contentType: "application/json",
          // El consumidor (ms-documentos, ms-notificaciones) retoma este trace-id al procesar.
          headers: getTraceId() ? { [TRACE_ID_HEADER]: getTraceId() } : {},
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }
}

module.exports = EventPublisher;
