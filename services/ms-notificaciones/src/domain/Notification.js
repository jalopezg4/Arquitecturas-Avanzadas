const mongoose = require("mongoose");

const ESTADOS = ["enviando", "enviado", "fallido"];

/**
 * Registro de cada aviso, con doble funcion:
 *  - IDEMPOTENCIA: `eventKey` es UNICO. Un evento repetido (RabbitMQ entrega "al menos una vez") no manda dos correos.
 *  - bitacora de envios (y "bandeja" de desarrollo cuando el transporte es console). NO guarda el cuerpo ni el
 *    correo del destinatario, solo el asunto y el estado.
 */
const notificationSchema = new mongoose.Schema(
  {
    eventKey: { type: String, required: true, unique: true },
    tipo: { type: String, required: true },
    ciudadanoId: { type: String, required: true, index: true },
    estado: { type: String, enum: ESTADOS, required: true },
    intentos: { type: Number, default: 1 },
    claimedAt: { type: Date, required: true },
    sentAt: { type: Date, default: null },
    asunto: { type: String, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
module.exports.ESTADOS = ESTADOS;
