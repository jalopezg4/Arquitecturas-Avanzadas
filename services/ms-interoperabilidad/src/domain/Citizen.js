const mongoose = require("mongoose");

/**
 * Copia LOCAL de los datos del ciudadano que necesita una transferencia saliente (HU-05c): cedula (para GovCarpeta y
 * el `id` del protocolo), nombre y correo (`citizenName`, `citizenEmail`) y direccion unica (RF-10: viaja al destino
 * para que no cambie). Llega en `ciudadano.registrado`, igual que `Folder` en ms-documentos o `Contact` en
 * ms-notificaciones (ADR-01: ningun servicio consulta la base ni la API de otro).
 */
const citizenSchema = new mongoose.Schema(
  {
    ciudadanoId: { type: String, required: true, unique: true },
    documento: { type: Number, required: true },
    nombre: { type: String, required: true },
    correo: { type: String, required: true },
    direccionUnica: { type: String, default: null },
    // Direccion fisica: GovCarpeta la exige para volver a afiliarlo si una transferencia falla (compensacion).
    direccion: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Citizen", citizenSchema);
