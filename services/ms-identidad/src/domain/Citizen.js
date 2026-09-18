const mongoose = require("mongoose");

// HU-01 AC: "La direccion unica es inmutable, con indice UNIQUE a nivel de base de datos"
// -- por eso `unique: true` en direccionUnica, no solo una validacion en el codigo de aplicacion.
const citizenSchema = new mongoose.Schema(
  {
    documento: { type: Number, required: true, unique: true },
    nombre: { type: String, required: true },
    direccion: { type: String, required: true },
    correo: { type: String, required: true },
    passwordHash: { type: String, required: true },
    direccionUnica: { type: String, required: true, unique: true, immutable: true },
    estado: {
      type: String,
      enum: ["pendiente", "activo", "transferido"],
      default: "pendiente",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Citizen", citizenSchema);
