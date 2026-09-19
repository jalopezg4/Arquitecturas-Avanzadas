const Folder = require("../domain/Folder");

class FolderRepository {
  /** Crea la carpeta si no existe. Idempotente y seguro ante llamadas simultaneas (el indice unico decide). */
  async ensure(ciudadanoId) {
    try {
      await Folder.updateOne({ ciudadanoId }, { $setOnInsert: { noCertificados: 0 } }, { upsert: true });
    } catch (err) {
      if (err && err.code === 11000) return; // otra peticion la creo justo antes: ya existe, que es lo que se queria
      throw err;
    }
  }

  /**
   * Reserva un cupo de forma atomica: incrementa solo si aun hay lugar. Devuelve false si la cuota esta llena.
   * Es UNA operacion, asi que N cargas simultaneas nunca superan `max`.
   */
  async reserveNonCertified(ciudadanoId, max) {
    await this.ensure(ciudadanoId);
    const updated = await Folder.findOneAndUpdate({ ciudadanoId, noCertificados: { $lt: max } }, { $inc: { noCertificados: 1 } }, { new: true });
    return Boolean(updated);
  }

  /** Devuelve un cupo (la carga fallo despues de reservarlo, o el documento paso a certificado). Nunca baja de 0. */
  async releaseNonCertified(ciudadanoId) {
    await Folder.findOneAndUpdate({ ciudadanoId, noCertificados: { $gt: 0 } }, { $inc: { noCertificados: -1 } });
  }

  async get(ciudadanoId) {
    return Folder.findOne({ ciudadanoId }).lean();
  }
}

module.exports = FolderRepository;
