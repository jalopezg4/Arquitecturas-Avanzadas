const mongoose = require("mongoose");

/**
 * Registro de refresh tokens emitidos (HU-02: "de un solo uso por rotacion").
 * Un JWT no se puede invalidar por si solo; para que un refresh token valga UNA vez hay que recordar cuales
 * ya se usaron. Se guarda solo el `jti` (identificador), nunca el token.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    jti: { type: String, required: true, unique: true },
    ciudadanoId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    // Mongo borra el registro cuando el token ya habria expirado de todas formas (indice TTL).
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RefreshToken", refreshTokenSchema);
