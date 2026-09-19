const mongoose = require("mongoose");

const ESTADOS = ["temporal", "certificado"];

/**
 * Metadatos de un documento de la carpeta (RF-19, RF-20). El archivo NO esta aqui: vive en el object storage y
 * solo se guarda su clave (`storageKey`). Un documento `temporal` cuenta para la cuota del ciudadano; uno
 * `certificado` (recibido de una entidad emisora o autenticado en GovCarpeta) no.
 */
const documentSchema = new mongoose.Schema(
  {
    ciudadanoId: { type: String, required: true, index: true },
    titulo: { type: String, required: true },
    entidadAvaladora: { type: String, required: true },
    fecha: { type: Date, required: true },
    estado: { type: String, enum: ESTADOS, default: "temporal", required: true },
    storageKey: { type: String, required: true, unique: true },
    mimeType: { type: String, required: true },
    tamanoBytes: { type: Number, required: true },
    // Huella del contenido: permite detectar alteraciones y sera la base de la autenticacion (HU-04).
    sha256: { type: String, required: true },
    // RF-30: si la carga sustituye provisionalmente un documento que una entidad pidio (HU-06.3/06.4).
    solicitudId: { type: String, default: null },
    // true cuando el broker confirmo el evento DocumentoCargado; false = requiere reconciliacion.
    eventoPublicado: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Document", documentSchema);
module.exports.ESTADOS = ESTADOS;
