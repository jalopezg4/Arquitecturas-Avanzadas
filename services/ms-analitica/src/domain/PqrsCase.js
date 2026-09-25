const mongoose = require("mongoose");

const TIPOS = ["peticion", "queja", "reclamo", "solicitud"];
// Minimos y explicitos (HU-07.2, MVP): sin workflow de aprobacion ni estados intermedios que nadie pidio todavia.
const ESTADOS = ["abierto", "en_proceso", "cerrado"];

/**
 * Caso PQRS de una institucion (HU-07.2). No se valida contra ms-documentos que `documentId` exista de verdad:
 * es una referencia opcional y de solo texto en este paso (ver "decisiones pendientes" del PASO 2), igual que
 * `entidadAvaladora` en ms-documentos es autodeclarado. La propiedad del caso es SIEMPRE `institutionId`, que
 * sale del token institucional (ADR-07) y nunca del cuerpo de la peticion.
 */
const pqrsCaseSchema = new mongoose.Schema(
  {
    institutionId: { type: String, required: true, index: true },
    type: { type: String, enum: TIPOS, required: true },
    subject: { type: String, required: true },
    description: { type: String, required: true },
    status: { type: String, enum: ESTADOS, default: "abierto", required: true },
    // Referencia opcional a un documento de ms-documentos (formato de ObjectId de Mongo); no se verifica su existencia.
    documentId: { type: String, default: null },
  },
  { timestamps: true }
);

// Cubre "listar los casos de una institucion" (orden mas reciente primero). La consulta por id usa el indice
// implicito de _id, no necesita uno propio.
pqrsCaseSchema.index({ institutionId: 1, createdAt: -1 });

module.exports = mongoose.model("PqrsCase", pqrsCaseSchema);
module.exports.TIPOS = TIPOS;
module.exports.ESTADOS = ESTADOS;
