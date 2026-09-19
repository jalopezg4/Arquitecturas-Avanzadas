const RefreshSession = require("../domain/RefreshSession");

class RefreshSessionRepository {
  async createSession({ familia, ciudadanoId, currentJti, expiresAt }) {
    return RefreshSession.create({ familia, ciudadanoId, currentJti, expiresAt });
  }

  /**
   * Canje atomico: solo prospera si la sesion sigue viva Y el token presentado es el vigente. Avanza al jti nuevo en
   * la misma operacion. Resultados:
   *  - "ok":      este canje gana; `newJti` pasa a ser el unico token valido de la sesion.
   *  - "reused":  el token ya se habia canjeado (posible robo).
   *  - "revoked": la sesion ya estaba revocada.
   *  - "unknown": la sesion no existe (nunca emitida o ya expirada y purgada).
   */
  async rotate({ familia, ciudadanoId, jti, newJti, expiresAt }) {
    const won = await RefreshSession.findOneAndUpdate({ familia, ciudadanoId, currentJti: jti, revokedAt: null }, { currentJti: newJti, expiresAt }, { new: true });
    if (won) return { status: "ok" };
    const existing = await RefreshSession.findOne({ familia, ciudadanoId });
    if (!existing) return { status: "unknown" };
    return { status: existing.revokedAt ? "revoked" : "reused" };
  }

  /** Revoca todas las sesiones vivas del ciudadano. Afecta tambien a un token recien emitido por un canje en curso. */
  async revokeAllFor(ciudadanoId, now) {
    const res = await RefreshSession.updateMany({ ciudadanoId, revokedAt: null }, { revokedAt: now });
    return res.modifiedCount;
  }
}

module.exports = RefreshSessionRepository;
