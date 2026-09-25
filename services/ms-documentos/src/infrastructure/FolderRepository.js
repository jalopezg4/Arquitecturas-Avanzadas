const Folder = require("../domain/Folder");
const logger = require("../tracing/logger");

/** Las direcciones unicas se comparan siempre normalizadas: son direcciones de correo, no distinguen mayusculas. */
function normalizeDireccion(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

class FolderRepository {
  /**
   * Crea la carpeta si no existe. Idempotente y seguro ante llamadas simultaneas (el indice unico decide).
   * Si el evento trae la `direccionUnica` (HU-01), la guarda o la actualiza: es el modelo de lectura que HU-10
   * usa para resolver al destinatario. Sin ella, la carpeta se crea igual (los eventos anteriores no la traian).
   */
  async ensure(ciudadanoId, direccionUnica) {
    const direccion = normalizeDireccion(direccionUnica);
    const update = { $setOnInsert: { noCertificados: 0 } };
    if (direccion) update.$set = { direccionUnica: direccion };
    try {
      await Folder.updateOne({ ciudadanoId }, update, { upsert: true });
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
      // Con dos indices unicos hay que distinguir contra cual se choco.
      if (err.keyPattern && err.keyPattern.direccionUnica) {
        // Esa direccion ya pertenece a OTRA carpeta. No deberia ocurrir (ms-identidad la garantiza unica), pero si
        // ocurre, el ciudadano debe tener su carpeta igual: se crea SIN direccion y no queda alcanzable por HU-10.
        logger.warn("carpeta.direccion_unica_en_conflicto", { note: "la direccion ya pertenece a otra carpeta; se crea sin ella" });
        await Folder.updateOne({ ciudadanoId }, { $setOnInsert: { noCertificados: 0 } }, { upsert: true }).catch((e) => {
          if (!e || e.code !== 11000) throw e;
        });
        return;
      }
      // Carrera por ciudadanoId: otra peticion la creo justo antes, que es lo que se queria.
    }
  }

  /**
   * HU-10: carpeta del ciudadano al que va dirigido un documento, buscada por su direccion unica. `null` si no hay
   * ninguna: quien llama responde lo mismo para "no existe" y para "formato invalido", sin revelar cual es cual.
   */
  async findByDireccionUnica(direccionUnica) {
    const direccion = normalizeDireccion(direccionUnica);
    if (!direccion) return null;
    return Folder.findOne({ direccionUnica: direccion }).lean();
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
