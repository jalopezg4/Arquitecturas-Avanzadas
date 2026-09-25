const mongoose = require("mongoose");

// Estados minimos de este PASO 1 (HU-06.3): solo el registro y la resolucion del ciudadano. Las transiciones
// autorizada/rechazada las escribe el PASO 2 (endpoints ciudadanos); aqui unicamente se declaran como validas.
const ESTADOS = ["pendiente_autorizacion", "autorizada", "rechazada"];

/**
 * Solicitud documental de una institucion sobre un ciudadano (HU-06.3, RF-27/28/29). Intra-operador: el ciudadano
 * ya es de este operador y se resuelve por su `direccionUnica` (a diferencia de `DocumentRequest` en ms-analitica,
 * HU-07.3, que es multioperador y nunca resuelve ni contacta al ciudadano -- son agregados distintos a proposito,
 * ver docs/SEGURIDAD.md seccion 12.3 y el diseno de HU-06.3).
 *
 * `institutionId` sale SIEMPRE del token institucional (ADR-07); `ciudadanoId` se resuelve SIEMPRE internamente
 * via `direccionUnica -> Folder` (mismo mecanismo que HU-10) y es INMUTABLE una vez creada la solicitud.
 */
const solicitudSchema = new mongoose.Schema(
  {
    institutionId: { type: String, required: true },
    ciudadanoId: { type: String, required: true },
    // Tal como la envio la entidad, normalizada con el mismo criterio que FolderRepository (trim + minusculas).
    direccionUnica: { type: String, required: true },
    descripcion: { type: String, required: true },
    estado: { type: String, enum: ESTADOS, default: "pendiente_autorizacion", required: true },
    // Trazabilidad del consentimiento (PASO 2): quien decidio y cuando. Ambos null hasta que el ciudadano decida.
    decisionAt: { type: Date, default: null },
    decisionBy: { type: String, default: null },
  },
  { timestamps: true }
);

// Los dos accesos que este paso necesita: "solicitudes de esta institucion" y, en el PASO 2, "solicitudes de este
// ciudadano" -- ambos mas recientes primero. Cubren tambien la consulta por institutionId/ciudadanoId solos (son
// el primer campo del indice). La consulta por id usa el indice implicito de _id; direccionUnica no se vuelve a
// consultar despues de crear (se resuelve una sola vez), asi que no se indexa.
solicitudSchema.index({ institutionId: 1, createdAt: -1 });
solicitudSchema.index({ ciudadanoId: 1, createdAt: -1 });

module.exports = mongoose.model("Solicitud", solicitudSchema);
module.exports.ESTADOS = ESTADOS;
