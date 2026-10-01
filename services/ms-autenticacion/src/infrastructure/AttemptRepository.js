const AuthenticationAttempt = require("../domain/AuthenticationAttempt");

class AttemptRepository {
  /**
   * Reclama el intento `eventId` de forma atomica. Devuelve:
   *   { claimed: true,  attempt }  -> este proceso debe llamar a GovCarpeta
   *   { claimed: false, attempt }  -> ya estaba resuelto, o lo esta procesando otro (reclamo reciente)
   * Un reclamo `procesando` mas viejo que `staleMs` se considera abandonado (el proceso murio) y se retoma.
   */
  async claim({ eventId, documentoId, ciudadanoId, intento }, { now, staleMs }) {
    try {
      const attempt = await AuthenticationAttempt.create({ eventId, documentoId, ciudadanoId, intento, reclamadoEn: now });
      return { claimed: true, attempt: attempt.toObject() };
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
    }
    const retaken = await AuthenticationAttempt.findOneAndUpdate(
      { eventId, estado: "procesando", reclamadoEn: { $lte: new Date(now.getTime() - staleMs) } },
      { $set: { reclamadoEn: now } },
      { new: true }
    ).lean();
    if (retaken) return { claimed: true, attempt: retaken };
    return { claimed: false, attempt: await AuthenticationAttempt.findOne({ eventId }).lean() };
  }

  /** Libera un reclamo `procesando` (fallo propio antes de resolver): la siguiente entrega lo retoma de inmediato. */
  async release(eventId) {
    await AuthenticationAttempt.updateOne({ eventId, estado: "procesando" }, { $set: { reclamadoEn: new Date(0) } });
  }

  async resolve(eventId, { estado, motivo, llamadasGovCarpeta, resueltoEn }) {
    return AuthenticationAttempt.findOneAndUpdate({ eventId }, { $set: { estado, motivo: motivo || null, llamadasGovCarpeta, resueltoEn } }, { new: true }).lean();
  }

  async markResultPublished(eventId) {
    await AuthenticationAttempt.updateOne({ eventId }, { resultadoPublicado: true });
  }
}

module.exports = AttemptRepository;
