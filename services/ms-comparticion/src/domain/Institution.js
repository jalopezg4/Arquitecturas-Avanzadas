const mongoose = require("mongoose");

const TIPOS = ["notaria", "universidad", "empresa", "otra"];

/**
 * Entidad institucional (RF-37): notaria, universidad, empresa... que recibe paquetes documentales en una carpeta
 * institucional propia (HU-06.2). La carpeta es un subdocumento: la entidad y su carpeta se crean en UNA sola
 * escritura atomica, asi que nunca existe una entidad sin carpeta (ni al reves).
 */
const institutionSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    tipo: { type: String, enum: TIPOS, required: true },
    // NIT sin puntos ni digito de verificacion: UNICO. Un mismo NIT no puede registrarse dos veces (409).
    nit: { type: String, required: true, unique: true },
    nitDv: { type: String, required: true },
    correoContacto: { type: String, required: true },
    telefono: { type: String, default: null },
    direccion: { type: String, default: null },
    // El registro es AUTODECLARADO: nadie ha comprobado que la entidad sea quien dice ser. HU-06.2 entrega documentos
    // de ciudadanos a esta carpeta, asi que este campo existe para que un proceso de verificacion futuro (no definido
    // en el caso de estudio) pueda distinguir a las instituciones verificadas. Ver docs/SEGURIDAD.md.
    verificada: { type: Boolean, default: false },
    carpeta: {
      id: { type: String, required: true },
      estado: { type: String, enum: ["activa"], default: "activa" },
      creadaEn: { type: Date, required: true },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Institution", institutionSchema);
module.exports.TIPOS = TIPOS;
