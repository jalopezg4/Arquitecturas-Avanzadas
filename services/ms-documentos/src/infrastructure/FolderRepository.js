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
    const update = { $setOnInsert: { noCertificados: 0 } };
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
        const sinDireccion = { $setOnInsert: { noCertificados: 0 } };
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
   * Reserva un cupo de forma atomica: incrementa solo si aun hay lugar. Devuelve false si la cuota esta llena.
   * Es UNA operacion, asi que N cargas simultaneas nunca superan `max`.
   */
  async reserveNonCertified(ciudadanoId, max) {
    await this.ensure(ciudadanoId);
    // `transferenciaId: null` en el mismo filtro (HU-05c): si la carpeta se bloqueo entre la comprobacion y esta
    // escritura, no se reserva nada.
    const updated = await Folder.findOneAndUpdate({ ciudadanoId, transferenciaId: null, noCertificados: { $lt: max } }, { $inc: { noCertificados: 1 } }, { new: true });
    if (!updated) await this.assertWritable(ciudadanoId); // distingue "carpeta bloqueada" de "cuota llena"
    return Boolean(updated);
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
    await Folder.updateOne({ ciudadanoId, transferenciaId }, { $set: { transferenciaId: null } });
  }

  /** HU-05c: el ciudadano ya esta en el otro operador: se borra su carpeta (solo si la bloqueo esa transferencia). */
  async deleteForTransfer(ciudadanoId, transferenciaId) {
    await Folder.deleteOne({ ciudadanoId, transferenciaId });
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
