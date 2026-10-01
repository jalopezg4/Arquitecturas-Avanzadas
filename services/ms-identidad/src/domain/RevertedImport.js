const mongoose = require("mongoose");

/**
 * HU-05c (destino): constancia de que la importacion de un ciudadano se REVIRTIO (`transferencia.revertir_registro`).
 * Una orden de registrar que llega tarde, o una importacion que estaba a mitad, la consulta y deshace lo suyo.
 */
const revertedImportSchema = new mongoose.Schema(
  {
    ciudadanoId: { type: String, required: true, unique: true },
    transferenciaId: { type: String, required: true },
    revertidaEn: { type: Date, required: true },
  },
  { timestamps: false }
);

module.exports = mongoose.model("RevertedImport", revertedImportSchema);
