const PqrsCase = require("../domain/PqrsCase");

class PqrsCaseRepository {
  async create(data) {
    return PqrsCase.create(data);
  }

  async findById(id) {
    return PqrsCase.findById(id).lean();
  }

  async listByInstitution(institutionId, { skip, limit }) {
    const filter = { institutionId };
    const [items, total] = await Promise.all([
      PqrsCase.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      PqrsCase.countDocuments(filter),
    ]);
    return { items, total };
  }

  async updateStatus(id, status) {
    return PqrsCase.findByIdAndUpdate(id, { status }, { new: true }).lean();
  }
}

module.exports = { PqrsCaseRepository };
