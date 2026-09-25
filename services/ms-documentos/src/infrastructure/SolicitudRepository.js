const Solicitud = require("../domain/Solicitud");

class SolicitudRepository {
  async create(data) {
    return Solicitud.create(data);
  }

  async findById(id) {
    return Solicitud.findById(id).lean();
  }

  /** Pagina de solicitudes de UNA institucion (filtra por dueno en la consulta misma), mas recientes primero. */
  async findByInstitution(institutionId, { skip, limit }) {
    const filter = { institutionId };
    const [items, total] = await Promise.all([
      Solicitud.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      Solicitud.countDocuments(filter),
    ]);
    return { items, total };
  }

  /** Pagina de solicitudes de UN ciudadano (filtra por dueno en la consulta misma), mas recientes primero. */
  async findByCitizen(ciudadanoId, { skip, limit }) {
    const filter = { ciudadanoId };
    const [items, total] = await Promise.all([
      Solicitud.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      Solicitud.countDocuments(filter),
    ]);
    return { items, total };
  }

  /**
   * Transicion ATOMICA: el filtro exige `estado: "pendiente_autorizacion"` ademas de `_id`/`ciudadanoId`, asi que
   * dos decisiones concurrentes sobre la misma solicitud nunca pueden ganar ambas -- la segunda encuentra el
   * filtro ya sin match (Mongo aplica un solo `findOneAndUpdate` a la vez sobre el mismo documento) y devuelve
   * `null`. Quien llama decide que codigo HTTP corresponde a ese `null`.
   */
  async decide(id, ciudadanoId, { estado, decisionAt, decisionBy }) {
    return Solicitud.findOneAndUpdate({ _id: id, ciudadanoId, estado: "pendiente_autorizacion" }, { $set: { estado, decisionAt, decisionBy } }, { new: true }).lean();
  }
}

module.exports = SolicitudRepository;
