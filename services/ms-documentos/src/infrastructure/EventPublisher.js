const amqp = require("amqplib");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

const EXCHANGE = "carpeta-ciudadana.events";

// ms-notificaciones aun no existe como servicio corriendo (siguiente PR de HU-03), pero el evento que publica este
// servicio es para el. Sin una cola ligada al topic exchange, RabbitMQ descarta el mensaje al no haber nadie
// suscrito; por eso se pre-declara aqui la cola que usara, durable y ligada a la routing key, para que los mensajes
// queden esperando hasta que exista el consumidor. Declarar una cola es idempotente.
const ANTICIPATED_BINDINGS = [{ queue: "ms-notificaciones.documento-cargado", routingKey: "documento.cargado" }];

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
          // El consumidor (ms-notificaciones) retoma este trace-id al procesar.
          headers: getTraceId() ? { [TRACE_ID_HEADER]: getTraceId() } : {},
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }
}

module.exports = EventPublisher;
