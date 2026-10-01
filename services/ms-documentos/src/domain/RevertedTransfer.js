const mongoose = require("mongoose");

/**
 * HU-05c (destino): constancia de que la importacion de una transferencia se REVIRTIO. Una orden de importar que llega
 * tarde (estaba en la cola o descargando cuando se revirtio) la consulta y no deja documentos huerfanos.
 */
const revertedTransferSchema = new mongoose.Schema(
  {
    transferenciaId: { type: String, required: true, unique: true },
    revertidaEn: { type: Date, required: true },
  },
  { timestamps: false }
);

module.exports = mongoose.model("RevertedTransfer", revertedTransferSchema);
