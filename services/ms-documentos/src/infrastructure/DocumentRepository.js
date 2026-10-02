const Document = require("../domain/Document");

class DocumentRepository {
  async create(data) {
    return Document.create(data);
  }

  async findById(id) {
    return Document.findById(id);
  }

  /** Ids de los documentos del ciudadano que ocupan cupo (RNF-04): temporales y los que estan en autenticacion. */
  async listNonCertifiedIds(ciudadanoId) {
    const docs = await Document.find({ ciudadanoId, estado: { $in: ["temporal", "en autenticacion"] } }, { _id: 1 }).lean();
    return docs.map((d) => String(d._id));
  }

  /** HU-10: el documento que esa institucion ya entrego con ese `envioId`, si lo hay (clave de idempotencia). */
  /** HU-01: la cedula firmada por la Registraduria que se guardo al crear la carpeta (o null). */
  async findIdCard(ciudadanoId) {
    return Document.findOne({ ciudadanoId, origen: "registraduria" }).lean();
  }

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

  /** HU-05c: TODOS los documentos de un ciudadano (para exportarlos o borrarlos), con un tope de seguridad. */
  async listAllByOwner(ciudadanoId, limit = 1000) {
    return Document.find({ ciudadanoId }).sort({ createdAt: 1 }).limit(limit).lean();
  }

  /** HU-05c (origen): los documentos de esa lista que siguen siendo del ciudadano (filtra por dueno). */
  async findByIdsForOwner(ciudadanoId, ids) {
    if (!ids.length) return [];
    return Document.find({ ciudadanoId, _id: { $in: ids } }).sort({ createdAt: 1 }).lean();
  }

  /** HU-05c (destino): lo importado por una transferencia (para idempotencia o para revertirla). */
  async findByTransfer(transferenciaOrigenId) {
    return Document.find({ transferenciaOrigenId }).lean();
  }

  async deleteByIds(ids) {
    if (!ids.length) return 0;
    return (await Document.deleteMany({ _id: { $in: ids } })).deletedCount;
  }

  /** Documentos cuyo evento `documento.cargado` no se pudo publicar, con al menos `olderThan` de antiguedad. */
  async findUnpublished({ olderThan, limit }) {
    return Document.find({ eventoPublicado: false, createdAt: { $lte: olderThan } }).sort({ createdAt: 1 }).limit(limit).lean();
  }

  async markEventPublished(id) {
    await Document.updateOne({ _id: id }, { eventoPublicado: true });
  }

  /**
   * HU-04: `temporal` -> `en autenticacion`, en UNA escritura condicional (dos solicitudes simultaneas: solo una
   * gana). El filtro incluye al dueno: un documento ajeno nunca cambia de estado aunque se conozca su id.
   * Devuelve el documento actualizado, o `null` si no existe, no es de ese ciudadano o no esta `temporal`.
   */
  async startAuthentication(id, ciudadanoId, now) {
    return Document.findOneAndUpdate(
      { _id: id, ciudadanoId, estado: "temporal" },
      { $set: { estado: "en autenticacion", autenticacionSolicitadaEn: now, autenticacionEventoPublicado: false }, $inc: { autenticacionIntento: 1 } },
      { new: true }
    ).lean();
  }

  /**
   * HU-04: GovCarpeta confirmo -> `certificado`. Solo si el documento sigue `en autenticacion` y en ESE intento:
   * un resultado repetido o de un intento anterior no hace nada (y quien llama no libera el cupo dos veces).
   */
  async completeAuthentication(id, intento, fechaAutenticacion) {
    return Document.findOneAndUpdate(
      { _id: id, estado: "en autenticacion", autenticacionIntento: intento },
      { $set: { estado: "certificado", fechaAutenticacion } },
      { new: true }
    ).lean();
  }

  /** HU-04: la autenticacion no se pudo completar -> vuelve a `temporal` (mismo criterio condicional). */
  async revertAuthentication(id, intento) {
    return Document.findOneAndUpdate({ _id: id, estado: "en autenticacion", autenticacionIntento: intento }, { $set: { estado: "temporal" } }, { new: true }).lean();
  }

  /** Solicitudes de autenticacion cuyo evento no se confirmo, con al menos `olderThan` de antiguedad. */
  async findUnpublishedAuthRequests({ olderThan, limit }) {
    return Document.find({ estado: "en autenticacion", autenticacionEventoPublicado: false, autenticacionSolicitadaEn: { $lte: olderThan } })
      .sort({ autenticacionSolicitadaEn: 1 })
      .limit(limit)
      .lean();
  }

  /** HU-04: documentos `en autenticacion` cuya solicitud SI se publico pero no tuvo resultado antes de `olderThan`. */
  async findStaleAuthentications({ olderThan, limit }) {
    return Document.find({ estado: "en autenticacion", autenticacionEventoPublicado: true, autenticacionSolicitadaEn: { $lte: olderThan } })
      .sort({ autenticacionSolicitadaEn: 1 })
      .limit(limit)
      .lean();
  }

  /** Marca publicado el evento del intento `intento` (si entretanto hubo otro intento, no toca su bandera). */
  async markAuthRequestPublished(id, intento) {
    await Document.updateOne({ _id: id, autenticacionIntento: intento }, { autenticacionEventoPublicado: true });
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
