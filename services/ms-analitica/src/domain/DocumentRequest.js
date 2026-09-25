const mongoose = require("mongoose");

// Unico estado de esta version (HU-07.3, implementacion PARCIAL). Los estados que implicarian el protocolo
// multioperador (enviada, pendiente_consentimiento, autorizada, rechazada, completada, transferida) dependen de
// HU-05c/HU-06.3, ninguna implementada todavia -- ver docs/SEGURIDAD.md, seccion 12.3.
const ESTADOS = ["registrada"];

/**
 * Solicitud documental registrada por una institucion (HU-07.3, RFP-02). SOLO un registro local: no resuelve
 * `direccionUnica` contra ningun ciudadano, no valida `operadorDestinoId` contra ningun directorio, no envia nada
 * a otro operador. La propiedad de la solicitud es SIEMPRE `institutionId`, que sale del token institucional
 * (ADR-07) y nunca del cuerpo de la peticion -- mismo principio que `PqrsCase` (HU-07.2).
 */
const documentRequestSchema = new mongoose.Schema(
  {
    institutionId: { type: String, required: true, index: true },
    // Identificador EXTERNO del ciudadano (HU-01); nunca se guarda ni se expone un ciudadanoId aqui.
    direccionUnica: { type: String, required: true },
    descripcion: { type: String, required: true },
    // Dato proporcionado por el solicitante, tal cual: representa un operador destino que la institucion YA
    // CONOCE de antemano, no uno descubierto por el sistema (no existe descubrimiento automatico hoy).
    operadorDestinoId: { type: String, default: null },
    estado: { type: String, enum: ESTADOS, default: "registrada", required: true },
  },
  { timestamps: true }
);

// Cubre "listar las solicitudes de una institucion" (orden mas reciente primero). La consulta por id usa el
// indice implicito de _id, no necesita uno propio.
documentRequestSchema.index({ institutionId: 1, createdAt: -1 });

module.exports = mongoose.model("DocumentRequest", documentRequestSchema);
module.exports.ESTADOS = ESTADOS;
