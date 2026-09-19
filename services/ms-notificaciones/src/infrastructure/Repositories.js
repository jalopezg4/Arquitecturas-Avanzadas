const Contact = require("../domain/Contact");
const Notification = require("../domain/Notification");

class ContactRepository {
  /** Crea o actualiza el contacto. Idempotente y seguro ante eventos simultaneos (el indice unico decide). */
  async upsert({ ciudadanoId, nombre, correo }) {
    const update = { $set: { nombre, correo } };
    try {
      await Contact.updateOne({ ciudadanoId }, update, { upsert: true });
    } catch (err) {
      if (err && err.code === 11000) return Contact.updateOne({ ciudadanoId }, update); // carrera entre dos eventos
      throw err;
    }
  }

  async find(ciudadanoId) {
    return Contact.findOne({ ciudadanoId }).lean();
  }
}

class NotificationRepository {
  /**
   * Reclama el aviso de forma ATOMICA. Devuelve {owner: true} solo a UN proceso; el resto (entrega repetida o
   * simultanea) recibe {owner: false} y no debe enviar nada. Se puede retomar un aviso:
   *  - `fallido` (el envio anterior fallo y el mensaje se reintenta), o
   *  - `enviando` ABANDONADO (mas viejo que staleMs: el proceso murio a medias).
   * Un aviso `enviado` nunca se reclama de nuevo.
   */
  async claim(eventKey, { tipo, ciudadanoId }, now, staleMs) {
    try {
      await Notification.create({ eventKey, tipo, ciudadanoId, estado: "enviando", intentos: 1, claimedAt: now });
      return { owner: true };
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
    }
    const retaken = await Notification.findOneAndUpdate(
      { eventKey, $or: [{ estado: "fallido" }, { estado: "enviando", claimedAt: { $lt: new Date(now.getTime() - staleMs) } }] },
      { $set: { estado: "enviando", claimedAt: now, error: null }, $inc: { intentos: 1 } },
      { new: true }
    );
    if (retaken) return { owner: true };
    const current = await Notification.findOne({ eventKey }).lean();
    return { owner: false, estado: current ? current.estado : undefined };
  }

  async markSent(eventKey, asunto, now) {
    await Notification.updateOne({ eventKey, estado: "enviando" }, { $set: { estado: "enviado", sentAt: now, asunto } });
  }

  async markFailed(eventKey, reason) {
    await Notification.updateOne({ eventKey, estado: "enviando" }, { $set: { estado: "fallido", error: String(reason).slice(0, 200) } });
  }
}

module.exports = { ContactRepository, NotificationRepository };
