const crypto = require("crypto");
const amqp = require("amqplib");
const logger = require("../tracing/logger");
const { runWithTrace, isValidTraceId, newTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

const EXCHANGE = "carpeta-ciudadana.events";

/** Mensaje que NUNCA se va a poder procesar (formato invalido, dato inexistente): no se reintenta, va a la cola de fallidos. */
class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermanentError";
  }
}

/**
 * Consumidor de una cola ligada al topic exchange (ADR-04).
 *
 * - Cola durable declarada SOLO como durable: la declara tambien el publicador (para que los mensajes esperen aunque
 *   este servicio no este corriendo) y RabbitMQ rechaza redeclararla con argumentos distintos. Por eso los mensajes
 *   imposibles de procesar NO usan dead-letter por argumentos: el propio consumidor los REPUBLICA en `<cola>.fallidos`
 *   (con el motivo) y recien entonces hace ACK. Si no logra republicarlos, los devuelve a la cola: nunca se pierden.
 * - prefetch acotado: un consumidor lento no se traga todo el trabajo.
 * - ACK solo cuando el manejador termina bien. Fallo transitorio (p. ej. Mongo o el correo caidos): se devuelve a la
 *   cola con RETROCESO EXPONENCIAL (1 s, 2 s, 4 s... hasta 60 s) y un TOPE de intentos; agotado el tope, el mensaje se
 *   republica en la cola de fallidos. Sin esto, una caida prolongada del correo giraria reintentando cada segundo
 *   para siempre y saturaria tanto este servicio como el servidor de correo.
 * - Retoma el trace-id del encabezado del mensaje para enlazar los logs con el request de origen.
 * - Si la conexion cae, reconecta con espera creciente.
 *
 * Los manejadores DEBEN ser idempotentes: RabbitMQ entrega "al menos una vez".
 */
class EventConsumer {
  constructor({ uri, queue, routingKey, handler, prefetch = 5, retryDelayMs = 1000, maxRetryDelayMs = 60000, maxAttempts = 8, connect = amqp.connect }) {
    this.uri = uri;
    this.queue = queue;
    this.routingKey = routingKey;
    this.handler = handler;
    this.prefetch = prefetch;
    this.retryDelayMs = retryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.maxAttempts = maxAttempts;
    // Intentos por mensaje (clave = huella del contenido: una reentrega trae otro deliveryTag). En memoria: si el
    // proceso reinicia, la cuenta vuelve a empezar, lo cual solo alarga un poco el reintento.
    this._attempts = new Map();
    this._connect = connect;
    this.failedQueue = `${queue}.fallidos`;
    this.connection = null;
    this.channel = null;
    this.stopping = false;
    this.reconnectAttempts = 0;
    this._timers = new Set();
  }

  async start() {
    this.stopping = false;
    this.connection = await this._connect(this.uri);
    this.connection.on("error", (err) => logger.error("consumidor.conexion_error", { queue: this.queue, err }));
    this.connection.on("close", () => this._scheduleReconnect());
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(EXCHANGE, "topic", { durable: true });
    await this.channel.assertQueue(this.failedQueue, { durable: true });
    await this.channel.assertQueue(this.queue, { durable: true });
    await this.channel.bindQueue(this.queue, EXCHANGE, this.routingKey);
    await this.channel.prefetch(this.prefetch);
    await this.channel.consume(this.queue, (msg) => this._onMessage(msg));
    this.reconnectAttempts = 0;
    logger.info("consumidor.iniciado", { queue: this.queue, routingKey: this.routingKey });
  }

  /** Republica el mensaje en la cola de fallidos con el motivo y hace ACK. Si no puede, lo devuelve a la cola. */
  _toFailedQueue(msg, reason) {
    const channel = this.channel;
    try {
      channel.sendToQueue(this.failedQueue, msg.content, {
        persistent: true,
        contentType: "application/json",
        headers: { ...((msg.properties && msg.properties.headers) || {}), "x-motivo-fallo": String(reason).slice(0, 200), "x-cola-origen": this.queue },
      });
      channel.ack(msg);
    } catch (err) {
      logger.error("consumidor.no_pudo_enviar_a_fallidos", { queue: this.queue, err });
      channel.nack(msg, false, true);
    }
  }

  _attemptKey(msg) {
    return crypto.createHash("sha1").update(msg.content).digest("hex");
  }

  _forget(msg) {
    this._attempts.delete(this._attemptKey(msg));
  }

  /** Cuenta un intento fallido; devuelve cuantos lleva el mensaje. Acota la memoria del contador. */
  _countAttempt(msg) {
    const key = this._attemptKey(msg);
    const n = (this._attempts.get(key) || 0) + 1;
    this._attempts.set(key, n);
    if (this._attempts.size > 10000) this._attempts.delete(this._attempts.keys().next().value); // descarta el mas antiguo
    return n;
  }

  _onMessage(msg) {
    if (!msg) return; // consumidor cancelado por el broker
    const channel = this.channel;
    let payload;
    try {
      payload = JSON.parse(msg.content.toString("utf8"));
    } catch {
      logger.error("consumidor.mensaje_invalido", { queue: this.queue, note: "JSON invalido; a la cola de fallidos" });
      return this._toFailedQueue(msg, "JSON invalido");
    }

    const incoming = msg.properties && msg.properties.headers && msg.properties.headers[TRACE_ID_HEADER];
    const traceId = isValidTraceId(incoming) ? incoming : newTraceId();

    return runWithTrace(traceId, async () => {
      try {
        await this.handler(payload);
        this._forget(msg);
        channel.ack(msg);
      } catch (err) {
        if (err instanceof PermanentError) {
          this._forget(msg);
          logger.error("consumidor.mensaje_rechazado", { queue: this.queue, err, note: "a la cola de fallidos" });
          return this._toFailedQueue(msg, err.message);
        }
        const attempt = this._countAttempt(msg);
        if (attempt >= this.maxAttempts) {
          this._forget(msg);
          logger.error("consumidor.reintentos_agotados", { queue: this.queue, intentos: attempt, err, note: "a la cola de fallidos" });
          return this._toFailedQueue(msg, `reintentos agotados (${attempt}): ${err.message}`);
        }
        const delay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** (attempt - 1));
        logger.error("consumidor.fallo_transitorio", { queue: this.queue, intento: attempt, reintentoEnMs: delay, err });
        const timer = setTimeout(() => {
          this._timers.delete(timer);
          try {
            channel.nack(msg, false, true);
          } catch {
            // el canal se cerro: el broker reentrega el mensaje solo al cerrarse la conexion
          }
        }, delay);
        if (timer.unref) timer.unref();
        this._timers.add(timer);
      }
    });
  }

  _scheduleReconnect() {
    if (this.stopping) return;
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts++);
    logger.warn("consumidor.reconectando", { queue: this.queue, enMs: delay });
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      this.start().catch((err) => {
        logger.error("consumidor.reconexion_fallida", { queue: this.queue, err });
        this._scheduleReconnect();
      });
    }, delay);
    if (timer.unref) timer.unref();
    this._timers.add(timer);
  }

  async stop() {
    this.stopping = true;
    this._timers.forEach(clearTimeout);
    this._timers.clear();
    try {
      if (this.channel) await this.channel.close();
      if (this.connection) await this.connection.close();
    } catch {
      // ya cerrado
    }
  }
}

module.exports = { EventConsumer, PermanentError, EXCHANGE };
