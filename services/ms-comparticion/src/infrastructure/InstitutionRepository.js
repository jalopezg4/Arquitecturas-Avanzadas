const Institution = require("../domain/Institution");

class DuplicateInstitutionError extends Error {
  constructor() {
    super("ya existe una institucion registrada con ese NIT");
    this.name = "DuplicateInstitutionError";
  }
}

class InstitutionRepository {
  /** Crea la entidad y su carpeta en UNA escritura. El indice UNICO sobre el NIT decide entre registros simultaneos. */
  async create(data) {
    try {
      return await Institution.create(data);
    } catch (err) {
      if (err && err.code === 11000) throw new DuplicateInstitutionError();
      throw err;
    }
  }

  async findByNit(nit) {
    return Institution.findOne({ nit }).lean();
  }
}

module.exports = { InstitutionRepository, DuplicateInstitutionError };
