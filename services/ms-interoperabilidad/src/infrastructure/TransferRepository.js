const Transfer = require("../domain/Transfer");

class TransferConflictError extends Error {
  constructor() {
    super("ya hay una transferencia en curso para este ciudadano");
    this.name = "TransferConflictError";
  }
}

const TERMINALES = ["completada", "fallida", "rechazada"];

/**
 * Persistencia de la saga. Todas las transiciones son escrituras CONDICIONALES sobre el estado esperado: dos
 * procesos (o una confirmacion que llega mientras el barrido reintenta) nunca aplican el mismo paso dos veces.
 */
class TransferRepository {
  async create(data) {
    try {
      return (await Transfer.create({ ...data, activa: true })).toObject();
    } catch (err) {
      if (err && err.code === 11000) throw new TransferConflictError();
      throw err;
    }
  }

  async findById(id) {
    return Transfer.findById(id).lean();
  }

  async findActive(tipo, filter) {
    return Transfer.findOne({ tipo, activa: true, ...filter }).lean();
  }

  /** La ultima transferencia (viva o no) de ese tipo para esa cedula: sirve para responder de forma idempotente. */
  async findLatestByDocumento(tipo, documento) {
    return Transfer.findOne({ tipo, documento }).sort({ createdAt: -1 }).lean();
  }

  /**
   * Pasa de `from` (uno o varios estados) a `to` con los campos de `set`. Devuelve la transferencia actualizada o
   * `null` si ya no estaba en `from` (otro proceso avanzo primero). Un estado terminal cierra la transferencia.
   */
  async transition(id, from, to, set = {}, inc) {
    const states = Array.isArray(from) ? from : [from];
    const update = { $set: { ...set, estado: to } };
    if (TERMINALES.includes(to)) Object.assign(update.$set, { activa: false, revisarEn: null, finalizadaEn: set.finalizadaEn || new Date() });
    if (inc) update.$inc = inc;
    return Transfer.findOneAndUpdate({ _id: id, estado: { $in: states } }, update, { new: true }).lean();
  }

  /** Actualiza campos sin cambiar de estado, solo si sigue en `estado`. */
  async update(id, estado, set, inc) {
    const update = { $set: set };
    if (inc) update.$inc = inc;
    return Transfer.findOneAndUpdate({ _id: id, estado }, update, { new: true }).lean();
  }

  /** Transferencias vivas cuyo plazo de revision ya paso (las reintenta o las da por vencidas el barrido). */
  async findDue(now, limit = 50) {
    return Transfer.find({ activa: true, revisarEn: { $lte: now } }).sort({ revisarEn: 1 }).limit(limit).lean();
  }
}

module.exports = { TransferRepository, TransferConflictError, TERMINALES };
