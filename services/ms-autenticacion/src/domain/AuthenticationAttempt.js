const mongoose = require("mongoose");

const ESTADOS = ["procesando", "autenticado", "fallido"];

/**
 * Registro de UN intento de autenticacion (uno por `eventId` de `documento.autenticacion_solicitada`). Existe para
 * que el consumidor sea idempotente (ADR-04: el bus entrega "al menos una vez"):
 *   - un reintento del mismo mensaje ya resuelto NO vuelve a llamar a GovCarpeta; si el resultado no alcanzo a
 *     publicarse, se republica el mismo resultado;
 *   - dos entregas simultaneas: solo una reclama el intento (indice unico + reclamo atomico).
 *
 * No guarda la cedula ni la URL firmada (la URL es una credencial temporal): solo identificadores y el resultado.
 */
const attemptSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    documentoId: { type: String, required: true, index: true },
    ciudadanoId: { type: String, required: true },
    intento: { type: Number, required: true },
    estado: { type: String, enum: ESTADOS, default: "procesando", required: true },
    // Por que fallo, si fallo: "rechazado" (GovCarpeta respondio definitivo) o "no_disponible" (reintentos agotados).
    motivo: { type: String, default: null },
    llamadasGovCarpeta: { type: Number, default: 0 },
    resueltoEn: { type: Date, default: null },
    // true cuando el broker confirmo el evento de resultado: hasta entonces, una reentrega lo republica.
    resultadoPublicado: { type: Boolean, default: false },
    reclamadoEn: { type: Date, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AuthenticationAttempt", attemptSchema);
module.exports.ESTADOS = ESTADOS;
