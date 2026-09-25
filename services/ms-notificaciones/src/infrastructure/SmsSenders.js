const logger = require("../tracing/logger");

/**
 * Puerto de salida de SMS: send({to, text}) -> Promise. HU-06.3 (RF-28), Paso 3.3-A: sin proveedor real todavia y
 * SIN nuevas dependencias -- el SMS es best-effort (un fallo nunca reintenta ni bloquea el evento, ver
 * NotificationService), asi que por ahora el unico transporte disponible es el simulado.
 */

/** No envia nada. Deja constancia en el log (sin el numero ni el texto) y resuelve siempre exitosamente. */
class ConsoleSmsSender {
  async send({ text }) {
    logger.info("sms.simulado", { note: "SMS_TRANSPORT=console: no se envio nada", textoLongitud: text.length });
    return { messageId: "console" };
  }
}

function createSmsSender(_sms) {
  return new ConsoleSmsSender(); // unico transporte disponible por ahora
}

module.exports = { ConsoleSmsSender, createSmsSender };
