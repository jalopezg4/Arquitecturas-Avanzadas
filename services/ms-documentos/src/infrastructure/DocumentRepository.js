const Document = require("../domain/Document");

class DocumentRepository {
  async create(data) {
    return Document.create(data);
  }

  async findById(id) {
    return Document.findById(id);
  }

  /** HU-10: el documento que esa institucion ya entrego con ese `envioId`, si lo hay (clave de idempotencia). */
  async findByEnvio(emisorInstitutionId, envioId) {
    return Document.findOne({ emisorInstitutionId, envioId }).lean();
  }

  /** Pagina de documentos de UN ciudadano (filtra por dueno en la consulta misma), mas recientes primero. */
  async listByOwner(ciudadanoId, { skip, limit }) {
    const filter = { ciudadanoId };
    const [items, total] = await Promise.all([
      Document.find(filter).sort({ fecha: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      Document.countDocuments(filter),
    ]);
    return { items, total };
  }

  /** Documentos cuyo evento `documento.cargado` no se pudo publicar, con al menos `olderThan` de antiguedad. */
  async findUnpublished({ olderThan, limit }) {
    return Document.find({ eventoPublicado: false, createdAt: { $lte: olderThan } }).sort({ createdAt: 1 }).limit(limit).lean();
  }

  async markEventPublished(id) {
    await Document.updateOne({ _id: id }, { eventoPublicado: true });
  }
}

module.exports = DocumentRepository;
