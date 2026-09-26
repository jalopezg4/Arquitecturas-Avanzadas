const mongoose = require("mongoose");

/**
 * HU-06.4 (RF-31): el ciudadano, que cargo un documento TEMPORAL (sin firma), le pide a la entidad emisora el documento
 * oficial definitivo. Cuando la entidad lo entrega (HU-10, indicando esta solicitud), el definitivo reemplaza al temporal.
 *
 *   resolviendo  -> se pregunto a ms-comparticion a que entidad corresponde el NIT
 *   pendiente    -> la entidad esta afiliada a este operador: la ve en su bandeja y puede entregar
 *   sin_entidad  -> el NIT no corresponde a ninguna entidad afiliada aqui: nadie puede atenderla (se informa al ciudadano)
 *   atendida     -> la entidad entrego el definitivo (`documentoDefinitivoId`); el temporal se reemplazo
 */
const ESTADOS = ["resolviendo", "pendiente", "sin_entidad", "atendida"];
const ABIERTOS = ["resolviendo", "pendiente"];

const officialRequestSchema = new mongoose.Schema(
  {
    ciudadanoId: { type: String, required: true, index: true },
    documentoTemporalId: { type: String, required: true },
    tituloDocumento: { type: String, required: true },
    nit: { type: String, required: true }, // normalizado: solo digitos, sin digito de verificacion
    institutionId: { type: String, default: null, index: true },
    nombreEntidad: { type: String, default: null },
    // Correo de contacto de la entidad (lo informa ms-comparticion al resolver) para avisarle de la solicitud nueva.
    correoEntidad: { type: String, default: null },
    // false = el aviso a la entidad (`solicitud_oficial.pendiente`) aun no se confirmo; lo reenvia el reconciliador.
    avisoPublicado: { type: Boolean, default: true },
    descripcion: { type: String, default: null },
    estado: { type: String, enum: ESTADOS, default: "resolviendo", required: true },
    // true mientras este resolviendo o pendiente (se apaga al pasar a sin_entidad o atendida).
    abierta: { type: Boolean, default: true },
    documentoDefinitivoId: { type: String, default: null },
    atendidaEn: { type: Date, default: null },
    // false = `solicitud_oficial.creada` no se confirmo en el broker; la reenvia el reconciliador.
    eventoPublicado: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Una sola solicitud ABIERTA por documento temporal (pedirla dos veces no crea dos).
officialRequestSchema.index({ documentoTemporalId: 1 }, { unique: true, partialFilterExpression: { abierta: true } });

module.exports = mongoose.model("OfficialRequest", officialRequestSchema);
module.exports.ESTADOS = ESTADOS;
module.exports.ABIERTOS = ABIERTOS;
