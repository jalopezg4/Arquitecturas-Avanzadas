const Package = require("../domain/Package");

class PackageRepository {
  async create(data) {
    return (await Package.create(data)).toObject();
  }

  async findById(id) {
    return Package.findById(id).lean();
  }

  async listByCitizen(ciudadanoId, { skip, limit }) {
    const filter = { ciudadanoId };
    const [items, total] = await Promise.all([Package.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), Package.countDocuments(filter)]);
    return { items, total };
  }

  /** Solo los ENTREGADOS en la carpeta de esa institucion (un paquete en proceso o rechazado no existe para ella). */
  async listDeliveredTo(institutionId, { skip, limit }) {
    const filter = { institutionId, canal: "carpeta_institucional", estado: "entregado" };
    const [items, total] = await Promise.all([Package.find(filter).sort({ entregadoEn: -1, _id: -1 }).skip(skip).limit(limit).lean(), Package.countDocuments(filter)]);
    return { items, total };
  }

  /** `procesando` -> estado final, una sola vez (una respuesta repetida de ms-documentos no hace nada). */
  async resolve(id, set) {
    return Package.findOneAndUpdate({ _id: id, estado: "procesando" }, { $set: set }, { new: true }).lean();
  }

  async markEventPublished(id) {
    await Package.updateOne({ _id: id }, { eventoPublicado: true });
  }

  async findUnpublished({ olderThan, limit }) {
    return Package.find({ estado: "procesando", eventoPublicado: false, createdAt: { $lte: olderThan } }).sort({ createdAt: 1 }).limit(limit).lean();
  }
}

module.exports = PackageRepository;
