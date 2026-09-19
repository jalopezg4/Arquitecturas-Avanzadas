const RefreshToken = require("../domain/RefreshToken");

class RefreshTokenRepository {
  async create({ jti, ciudadanoId, expiresAt }) {
    return RefreshToken.create({ jti, ciudadanoId, expiresAt });
  }

  /**
   * Marca el token como usado de forma ATOMICA. Devuelve "ok" solo a quien lo consume primero;
   * "reused" si ya estaba usado o revocado (posible robo: alguien presenta un token ya gastado);
   * "unknown" si no existe (nunca emitido o ya expirado y purgado).
   */
  async consume(jti, now) {
    const consumed = await RefreshToken.findOneAndUpdate({ jti, usedAt: null, revokedAt: null }, { usedAt: now }, { new: true });
    if (consumed) return { status: "ok", ciudadanoId: consumed.ciudadanoId };
    const existing = await RefreshToken.findOne({ jti });
    return existing ? { status: "reused", ciudadanoId: existing.ciudadanoId } : { status: "unknown" };
  }

  /** Invalida todos los refresh tokens vivos de un ciudadano (reutilizacion detectada). */
  async revokeAllFor(ciudadanoId, now) {
    const res = await RefreshToken.updateMany({ ciudadanoId, revokedAt: null }, { revokedAt: now });
    return res.modifiedCount;
  }
}

module.exports = RefreshTokenRepository;
