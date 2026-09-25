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

  /**
   * HU-07.1: agregaciones de SOLO los documentos que `emisorInstitutionId` entrego (nunca los que un ciudadano
   * cargo por su cuenta: esos no llevan `emisorInstitutionId`). `from`/`to` ya vienen como `Date` (o `null`) --
   * la interpretacion de los parametros de la peticion es responsabilidad del servicio, no de este repositorio.
   * `emisorInstitutionId` ya esta indexado (Document.js); `fecha` no -- ver nota en DocumentAnalyticsService.
   */
  async summarizeByEmisor(emisorInstitutionId, { from, to } = {}) {
    const match = { emisorInstitutionId };
    if (from || to) {
      match.fecha = {};
      if (from) match.fecha.$gte = from;
      if (to) match.fecha.$lte = to;
    }
    const [facets] = await Document.aggregate([
      { $match: match },
      {
        $facet: {
          total: [{ $count: "count" }],
          porEstado: [{ $group: { _id: "$estado", count: { $sum: 1 } } }],
          porMimeType: [{ $group: { _id: "$mimeType", count: { $sum: 1 } } }],
          tamano: [{ $group: { _id: null, total: { $sum: "$tamanoBytes" }, promedio: { $avg: "$tamanoBytes" } } }],
          serieTemporal: [
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$fecha", timezone: "UTC" } }, cantidad: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]);
    return facets;
  }
}

module.exports = DocumentRepository;
