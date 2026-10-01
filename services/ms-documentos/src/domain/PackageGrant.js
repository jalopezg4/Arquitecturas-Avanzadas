const mongoose = require("mongoose");

/**
 * HU-06.2 (RF-25): permiso de LECTURA que un ciudadano concede a una entidad sobre documentos concretos de su carpeta,
 * al entregarle un paquete documental en su carpeta institucional. ms-documentos es el dueno del acceso a los archivos:
 * la entidad solo puede descargar lo que este permiso enumera, y solo mientras el documento siga siendo del ciudadano.
 */
const packageGrantSchema = new mongoose.Schema(
  {
    paqueteId: { type: String, required: true, unique: true },
    institutionId: { type: String, required: true, index: true },
    ciudadanoId: { type: String, required: true },
    documentoIds: { type: [String], required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PackageGrant", packageGrantSchema);
