const mongoose = require("mongoose");

// HU-01 AC: "La direccion unica es inmutable, con indice UNIQUE a nivel de base de datos"
// -- por eso `unique: true` en direccionUnica, no solo una validacion en el codigo de aplicacion.
const citizenSchema = new mongoose.Schema(
  {
    documento: { type: Number, required: true, unique: true },
    nombre: { type: String, required: true },
    direccion: { type: String, required: true },
    correo: { type: String, required: true },
    // HU-06.3 (RF-28): OPCIONAL a proposito -- no rompe a los ciudadanos ya registrados y el caso de estudio nunca
    // lo exige para registrarse. `null` mientras no se informe; viaja en `ciudadano.registrado` para que
    // ms-notificaciones pueda enviar SMS ademas de correo cuando exista.
    telefono: { type: String, default: null },
    passwordHash: { type: String, required: true },
    // HU-02: proteccion contra fuerza bruta. El contador y el bloqueo se actualizan de forma
    // atomica en CitizenRepository (nunca leer-modificar-guardar: dos intentos simultaneos se perderian).
    intentosFallidos: { type: Number, default: 0 },
    bloqueadoHasta: { type: Date, default: null },
    direccionUnica: { type: String, required: true, unique: true, immutable: true },
    // true cuando el broker confirmo `ciudadano.registrado`; false = hay que reenviarlo (PendingRegistrationReconciler).
    // Los ciudadanos anteriores a este campo no lo tienen y no se reenvian.
    eventoPublicado: { type: Boolean, default: false },
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
