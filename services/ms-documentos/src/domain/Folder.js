const mongoose = require("mongoose");

/**
 * Contador de la carpeta de un ciudadano: cuantos documentos NO certificados tiene. Existe como documento aparte
 * (y no como `countDocuments`) para poder reservar cupo de forma ATOMICA: contar y luego insertar deja pasar
 * varias cargas simultaneas por encima del limite.
 */
const folderSchema = new mongoose.Schema(
  {
    ciudadanoId: { type: String, required: true, unique: true },
    noCertificados: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Folder", folderSchema);
