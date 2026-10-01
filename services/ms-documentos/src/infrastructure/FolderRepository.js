const Folder = require("../domain/Folder");
const logger = require("../tracing/logger");
const { CarpetaEnTransferenciaError } = require("../domain/errors");

/** Las direcciones unicas se comparan siempre normalizadas: son direcciones de correo, no distinguen mayusculas. */
function normalizeDireccion(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

/** Cedula valida: entero positivo exacto (GovCarpeta la maneja como `number`). Cualquier otra cosa -> null. */
function normalizeDocumento(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

class FolderRepository {
  /**
   * Crea la carpeta si no existe. Idempotente y seguro ante llamadas simultaneas (el indice unico decide).
   * Si el evento trae la `direccionUnica` (HU-01), la guarda o la actualiza: es el modelo de lectura que HU-10
   * usa para resolver al destinatario. Sin ella, la carpeta se crea igual (los eventos anteriores no la traian).
   * Igual con el `documento` (cedula, HU-04): se guarda si llega y es valido, nunca se borra si falta.
   */
  async ensure(ciudadanoId, direccionUnica, documento) {
    const direccion = normalizeDireccion(direccionUnica);
    const cedula = normalizeDocumento(documento);
    const update = { $setOnInsert: { noCertificados: 0, cupos: [] } };
    const set = {};
    if (direccion) set.direccionUnica = direccion;
    if (cedula) set.documento = cedula;
    if (Object.keys(set).length) update.$set = set;
    try {
      await Folder.updateOne({ ciudadanoId }, update, { upsert: true });
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
      // Con dos indices unicos hay que distinguir contra cual se choco.
      if (err.keyPattern && err.keyPattern.direccionUnica) {
        // Esa direccion ya pertenece a OTRA carpeta. No deberia ocurrir (ms-identidad la garantiza unica), pero si
        // ocurre, el ciudadano debe tener su carpeta igual: se crea SIN direccion y no queda alcanzable por HU-10.
        logger.warn("carpeta.direccion_unica_en_conflicto", { note: "la direccion ya pertenece a otra carpeta; se crea sin ella" });
        const sinDireccion = { $setOnInsert: { noCertificados: 0, cupos: [] } };
        if (cedula) sinDireccion.$set = { documento: cedula };
        await Folder.updateOne({ ciudadanoId }, sinDireccion, { upsert: true }).catch((e) => {
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
   * Reserva el cupo del documento `documentoId` (su id se genera ANTES de crearlo) de forma atomica: solo si aun hay
   * lugar. Devuelve false si la cuota esta llena. Es UNA operacion, asi que N cargas simultaneas nunca superan `max`.
   * Reservar dos veces el mismo documento cuenta una sola vez.
   */
  async reserveNonCertified(ciudadanoId, documentoId, max) {
    await this.ensure(ciudadanoId);
    const id = String(documentoId);
    // `transferenciaId: null` en el mismo filtro (HU-05c): si la carpeta se bloqueo entre la comprobacion y esta
    // escritura, no se reserva nada.
    const updated = await Folder.findOneAndUpdate(
      { ciudadanoId, transferenciaId: null, noCertificados: { $lt: max }, cupos: { $ne: id } },
      { $push: { cupos: id }, $inc: { noCertificados: 1 } },
      { new: true }
    );
    if (updated) return true;
    const folder = await Folder.findOne({ ciudadanoId, cupos: id }, { _id: 1 }).lean();
    if (folder) return true; // ya estaba reservado (reintento)
    await this.assertWritable(ciudadanoId); // distingue "carpeta bloqueada" de "cuota llena"
    return false;
  }

  /** HU-05c: lanza CarpetaEnTransferenciaError si la carpeta esta en solo lectura. Una carpeta inexistente se puede escribir. */
  async assertWritable(ciudadanoId) {
    const folder = await Folder.findOne({ ciudadanoId }, { transferenciaId: 1 }).lean();
    if (folder && folder.transferenciaId) throw new CarpetaEnTransferenciaError();
  }

  /**
   * HU-05c: pone la carpeta en solo lectura para la transferencia `transferenciaId`. Idempotente para la misma
   * transferencia; devuelve `null` si ya la bloqueo OTRA. Si el ciudadano no tiene carpeta (nunca cargo nada), se crea
   * ya bloqueada.
   */
  async lockForTransfer(ciudadanoId, transferenciaId) {
    const locked = await Folder.findOneAndUpdate({ ciudadanoId, transferenciaId: { $in: [null, transferenciaId] } }, { $set: { transferenciaId } }, { new: true }).lean();
    if (locked) return locked;
    try {
      return (await Folder.create({ ciudadanoId, transferenciaId })).toObject();
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
      return null; // existe y la tiene otra transferencia
    }
  }

  /** HU-05c: vuelve a permitir escrituras (transferencia fallida). Solo si la bloqueo ESA transferencia. */
  async unlock(ciudadanoId, transferenciaId) {
    await Folder.updateOne({ ciudadanoId, transferenciaId }, { $set: { transferenciaId: null }, $unset: { exportados: 1 } });
  }

  /**
   * HU-05c: fija QUE documentos exporta la transferencia. Solo la primera vez: una exportacion repetida (reintento de
   * la orden) reutiliza la misma lista, asi el origen nunca borra algo distinto de lo que mando. Devuelve la lista
   * vigente, o null si la carpeta ya no la tiene bloqueada esa transferencia.
   */
  async setExported(ciudadanoId, transferenciaId, documentoIds) {
    const ids = documentoIds.map(String);
    const set = await Folder.findOneAndUpdate({ ciudadanoId, transferenciaId, exportados: { $exists: false } }, { $set: { exportados: ids } }, { new: true }).lean();
    if (set) return set.exportados;
    const folder = await Folder.findOne({ ciudadanoId, transferenciaId }, { exportados: 1 }).lean();
    return folder ? folder.exportados || null : null;
  }

  /** HU-05c: el ciudadano ya esta en el otro operador: se borra su carpeta (solo si la bloqueo esa transferencia). */
  async deleteForTransfer(ciudadanoId, transferenciaId) {
    await Folder.deleteOne({ ciudadanoId, transferenciaId });
  }

  /**
   * Devuelve el cupo del documento `documentoId` (la carga fallo despues de reservarlo, el documento paso a
   * certificado o se borro). IDEMPOTENTE: si ese documento ya no ocupaba cupo, no hace nada. Devuelve si libero.
   */
  async releaseNonCertified(ciudadanoId, documentoId) {
    const id = String(documentoId);
    const r = await Folder.updateOne({ ciudadanoId, cupos: id }, { $pull: { cupos: id }, $inc: { noCertificados: -1 } });
    return r.modifiedCount > 0;
  }

  /**
   * HU-05c (destino): los temporales importados ocupan cupo, aunque superen el maximo (no se pierden al llegar).
   * Idempotente por documento: una importacion reintentada no los cuenta dos veces ni deja alguno sin contar.
   */
  async addNonCertified(ciudadanoId, documentoIds) {
    for (const documentoId of documentoIds) {
      const id = String(documentoId);
      await Folder.updateOne({ ciudadanoId, cupos: { $ne: id } }, { $push: { cupos: id }, $inc: { noCertificados: 1 } });
    }
  }

  /**
   * QuotaReconciler: deja `cupos` igual a los documentos que de verdad ocupan cupo. `vigentes` son los ids de los
   * temporales / en autenticacion del ciudadano; `liberables` son ids de `cupos` sin documento que ya no pueden ser
   * una carga en curso. Cada cambio es idempotente y atomico, igual que una carga o una liberacion normal.
   */
  async reconcileQuota(ciudadanoId, { faltantes, liberables, now }) {
    await this.addNonCertified(ciudadanoId, faltantes);
    for (const id of liberables) await this.releaseNonCertified(ciudadanoId, id);
    await Folder.updateOne({ ciudadanoId }, { $set: { cuposRevisadosEn: now } });
  }

  /** Carpetas con cuota a revisar, las revisadas hace mas tiempo primero. */
  async findForQuotaReview(limit) {
    return Folder.find({ cupos: { $exists: true } }, { ciudadanoId: 1, cupos: 1 }).sort({ cuposRevisadosEn: 1 }).limit(limit).lean();
  }

  /**
   * Carpetas anteriores a `cupos` (solo tenian el contador): se reconstruye la lista desde sus documentos. Solo toca
   * las que aun no la tienen, asi que es idempotente; se corre al arrancar, antes de aceptar cargas.
   */
  async migrateLegacyQuota(listNonCertifiedIds) {
    let migradas = 0;
    for await (const folder of Folder.find({ cupos: { $exists: false } }, { ciudadanoId: 1 }).lean().cursor()) {
      const ids = (await listNonCertifiedIds(folder.ciudadanoId)).map(String);
      const r = await Folder.updateOne({ _id: folder._id, cupos: { $exists: false } }, { $set: { cupos: ids, noCertificados: ids.length } });
      migradas += r.modifiedCount;
    }
    return migradas;
  }

  /** HU-05c (destino): revertir una importacion. Solo borra la carpeta si ya no tiene documentos. */
  async deleteIfEmpty(ciudadanoId, remaining) {
    if (remaining === 0) await Folder.deleteOne({ ciudadanoId });
  }

  async get(ciudadanoId) {
    return Folder.findOne({ ciudadanoId }).lean();
  }
}

module.exports = FolderRepository;
