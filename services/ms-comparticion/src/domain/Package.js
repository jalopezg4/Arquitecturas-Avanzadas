const mongoose = require("mongoose");

const CANALES = ["carpeta_institucional", "correo"];
const ESTADOS = ["procesando", "entregado", "rechazado"];

/**
 * Paquete documental (HU-06.2, RF-24/25/26): varios documentos de la carpeta de un ciudadano enviados juntos a una
 * entidad. NO duplica archivos: guarda solo los ids de documentos que siguen viviendo en ms-documentos.
 *
 *   canal "carpeta_institucional" -> la entidad esta registrada y VERIFICADA: el paquete aparece en su carpeta y
 *                                     descarga cada documento con su token (RF-25)
 *   canal "correo"                -> cualquier otro caso: se envia por correo con enlaces temporales (RF-26)
 *
 * `procesando` hasta que ms-documentos confirma que los documentos son del ciudadano (y concede el acceso o envia el
 * correo); entonces `entregado`, o `rechazado` con el motivo.
 */
const packageSchema = new mongoose.Schema(
  {
    ciudadanoId: { type: String, required: true, index: true },
    documentoIds: { type: [String], required: true },
    canal: { type: String, enum: CANALES, required: true },
    // canal carpeta_institucional
    institutionId: { type: String, default: null, index: true },
    // canal correo (a una entidad no verificada se le escribe a su correo de contacto registrado)
    correoDestino: { type: String, default: null },
    nombreDestino: { type: String, default: null },
    estado: { type: String, enum: ESTADOS, default: "procesando", required: true },
    motivo: { type: String, default: null },
    // Lo que la entidad ve del paquete: metadatos que confirma ms-documentos (nunca claves de storage ni URLs).
    documentos: {
      type: [{ documentoId: String, titulo: String, entidadAvaladora: String, fecha: Date, mimeType: String, _id: false }],
      default: [],
    },
    remitenteDireccionUnica: { type: String, default: null },
    entregadoEn: { type: Date, default: null },
    // false = `paquete.creado` no se confirmo en el broker; lo reenvia PackageEventReconciler.
    eventoPublicado: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Package", packageSchema);
module.exports.CANALES = CANALES;
module.exports.ESTADOS = ESTADOS;
