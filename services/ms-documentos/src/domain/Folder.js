const mongoose = require("mongoose");

/**
 * Contador de la carpeta de un ciudadano: cuantos documentos NO certificados tiene. Existe como documento aparte
 * (y no como `countDocuments`) para poder reservar cupo de forma ATOMICA: contar y luego insertar deja pasar
 * varias cargas simultaneas por encima del limite.
 *
 * Ademas es el MODELO DE LECTURA local del ciudadano en este servicio (HU-10): guarda su `direccionUnica`, que
 * llega en el evento `ciudadano.registrado` (ADR-01: cada servicio posee sus datos y ninguno consulta la base ni
 * la API de otro). Es el mismo patron que `Contact` en ms-notificaciones.
 */
const folderSchema = new mongoose.Schema(
  {
    ciudadanoId: { type: String, required: true, unique: true },
    noCertificados: { type: Number, default: 0, min: 0 },
    // Direccion unica del ciudadano (HU-01), copia local. Es por donde una entidad emisora dirige un documento
    // (HU-10), nunca por el id interno. `null` mientras no haya llegado el evento que la trae.
    direccionUnica: { type: String, default: null },
  },
  { timestamps: true }
);

// UNICO pero solo entre las carpetas que ya tienen direccion: un indice `sparse` no serviria porque `null` cuenta
// como valor presente y varias carpetas sin direccion chocarian entre si.
folderSchema.index({ direccionUnica: 1 }, { unique: true, partialFilterExpression: { direccionUnica: { $type: "string" } } });

module.exports = mongoose.model("Folder", folderSchema);
