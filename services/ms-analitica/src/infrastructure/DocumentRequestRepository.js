const DocumentRequest = require("../domain/DocumentRequest");

class DocumentRequestRepository {
  async create(data) {
    return DocumentRequest.create(data);
  }

  async findById(id) {
    return DocumentRequest.findById(id).lean();
  }

  async findByInstitution(institutionId, { skip, limit }) {
    const filter = { institutionId };
    const [items, total] = await Promise.all([
      DocumentRequest.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      DocumentRequest.countDocuments(filter),
    ]);
    return { items, total };
  }
}

module.exports = { DocumentRequestRepository };
