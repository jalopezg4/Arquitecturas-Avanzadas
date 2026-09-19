const mongoose = require("mongoose");

/**
 * Sesion de refresh (HU-02: refresh token "de un solo uso por rotacion").
 *
 * Un login abre una sesion (familia). Cada canje avanza `currentJti` al jti del token nuevo: solo el token que
 * lleva el `currentJti` vigente puede canjearse. Todo el estado vive en UN documento, asi el canje es una
 * comparacion-y-cambio atomica y no hay ventana entre "consumir" y "emitir" en la que una revocacion se pierda.
 * Se guardan identificadores, nunca el token.
 */
const refreshSessionSchema = new mongoose.Schema(
  {
    familia: { type: String, required: true, unique: true },
    ciudadanoId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    currentJti: { type: String, required: true },
    revokedAt: { type: Date, default: null },
    // Mongo borra la sesion cuando su ultimo token ya habria expirado (indice TTL); se extiende en cada canje.
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RefreshSession", refreshSessionSchema);
