const mongoose = require("mongoose");

/**
 * A quien avisar. Copia LOCAL (modelo de lectura) de lo que ms-identidad publica en ciudadano.registrado: cada
 * servicio posee sus datos y ninguno consulta la base de otro. Solo lo necesario para escribirle al ciudadano.
 */
const contactSchema = new mongoose.Schema(
  {
    ciudadanoId: { type: String, required: true, unique: true },
    nombre: { type: String, required: true },
    correo: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Contact", contactSchema);
