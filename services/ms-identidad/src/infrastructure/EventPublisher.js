const amqp = require("amqplib");

const EXCHANGE = "carpeta-ciudadana.events";

class EventPublisher {
  constructor(rabbitUri) {
    this.rabbitUri = rabbitUri;
    this.channel = null;
  }

  async connect() {
    const conn = await amqp.connect(this.rabbitUri);
    this.channel = await conn.createChannel();
    await this.channel.assertExchange(EXCHANGE, "topic", { durable: true });
  }

  /** Publica un evento; el mensaje es JSON persistente (ADR-04). */
  async publish(routingKey, payload) {
    if (!this.channel) await this.connect();
    this.channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      contentType: "application/json",
    });
  }
}

module.exports = EventPublisher;
