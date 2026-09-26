const amqp = require("amqplib");
const logger = require("../tracing/logger");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

const EXCHANGE = "carpeta-ciudadana.events";

// HU-05c: ordenes y avisos de la saga de transferencia. Sin una cola ligada al topic exchange, RabbitMQ descarta el
// mensaje al no haber nadie suscrito; por eso se pre-declaran aqui las colas de quienes los consumen, durables y
// ligadas a su routing key, para que esperen aunque el consumidor no este corriendo. Declarar una cola es idempotente.
const ANTICIPATED_BINDINGS = [
  { queue: "ms-documentos.transferencia-exportar", routingKey: "transferencia.exportar_carpeta" },
  { queue: "ms-documentos.transferencia-cancelada", routingKey: "transferencia.cancelada" },
  { queue: "ms-documentos.ciudadano-transferido", routingKey: "ciudadano.transferido" },
  { queue: "ms-identidad.ciudadano-transferido", routingKey: "ciudadano.transferido" },
  { queue: "ms-documentos.transferencia-importar", routingKey: "transferencia.importar_documentos" },
  { queue: "ms-documentos.transferencia-revertir", routingKey: "transferencia.revertir_importacion" },
  { queue: "ms-identidad.transferencia-registrar", routingKey: "transferencia.registrar_ciudadano" },
];

class EventPublisher {
  constructor(rabbitUri, { connect = amqp.connect } = {}) {
    this.rabbitUri = rabbitUri;
    this._connect = connect;
    this.channel = null;
    this._connecting = null;
  }

  /** Abre (o reutiliza la apertura en curso de) la conexion: varias publicaciones simultaneas no abren varias. */
  connect() {
    if (!this._connecting) {
      this._connecting = this._open().finally(() => {
        this._connecting = null;
      });
    }
    return this._connecting;
  }

  async _open() {
    const conn = await this._connect(this.rabbitUri);
    // Sin un oyente de "error", amqplib lo relanza como excepcion no capturada y tumba el proceso.
    conn.on("error", (err) => logger.error("publicador.conexion_error", { err }));
    // Canal confirmable: publish() solo resuelve cuando el broker confirma que acepto (y, al ser `persistent`,
    // persistio) el mensaje -- no basta con que el buffer local lo haya aceptado para escribir en el socket.
    const channel = await conn.createConfirmChannel();
    // Si el broker se reinicia, el canal queda muerto. Se olvida para que la siguiente publicacion reconecte: sin esto
    // TODA publicacion fallaba hasta reiniciar el servicio.
    const forget = () => {
      if (this.channel === channel) this.channel = null;
    };
    conn.on("close", forget);
    channel.on("close", forget);
    channel.on("error", (err) => logger.error("publicador.canal_error", { err }));
    await channel.assertExchange(EXCHANGE, "topic", { durable: true });
    for (const { queue, routingKey } of ANTICIPATED_BINDINGS) {
      await channel.assertQueue(queue, { durable: true });
      await channel.bindQueue(queue, EXCHANGE, routingKey);
    }
    this.channel = channel;
  }

  /**
   * Publica un evento; el mensaje es JSON persistente (ADR-04).
   * Devuelve una promesa que solo resuelve cuando el broker confirma la entrega/persistencia;
   * si el broker rechaza (nack) o la conexion cae antes de confirmar, rechaza la promesa.
   */
  async publish(routingKey, payload) {
    if (!this.channel) await this.connect();
    const channel = this.channel;
    return new Promise((resolve, reject) => {
      channel.publish(
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
