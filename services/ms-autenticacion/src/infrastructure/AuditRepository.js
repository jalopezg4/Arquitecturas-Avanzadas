const AuditEntry = require("../domain/AuditEntry");

class AuditRepository {
  async create(entry) {
    return AuditEntry.create(entry);
  }

  /** Entradas con timestamp en [from, to]. Ambos limites son opcionales. */
  async findInPeriod({ from, to } = {}) {
    const query = {};
    if (from || to) {
      query.timestamp = {};
      if (from) query.timestamp.$gte = from;
      if (to) query.timestamp.$lte = to;
    }
    return AuditEntry.find(query).sort({ timestamp: 1 }).lean();
  }
}

module.exports = AuditRepository;
