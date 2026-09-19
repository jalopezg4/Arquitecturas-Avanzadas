const crypto = require("crypto");
const Operator = require("../domain/Operator");
const DirectoryState = require("../domain/DirectoryState");

/** Minusculas y espacios colapsados: "  Carpeta   CIUDADANA " y "carpeta ciudadana" son el mismo nombre. */
function nameKey(name) {
  return String(name).trim().replace(/\s+/g, " ").toLowerCase();
}

class OperatorRepository {
  async getState() {
    return DirectoryState.findById("directory").lean();
  }

  /**
   * Reemplaza el directorio por uno nuevo SIN dejarlo a medias:
   *   1) se escribe una generacion nueva completa (si algo falla aqui, el directorio anterior sigue intacto)
   *   2) se cambia el puntero (un solo documento: es lo que "publica" el refresco)
   *   3) se borran las generaciones viejas (limpieza; si falla no afecta a los lectores)
   */
  async replaceDirectory(operators, now) {
    const generation = crypto.randomUUID();
    try {
      if (operators.length) {
        await Operator.insertMany(
          operators.map((o) => ({ generation, operatorId: o.id, name: o.name, nameKey: nameKey(o.name), transferApiUrl: o.transferApiUrl, participants: o.participants })),
          { ordered: true }
        );
      }
    } catch (err) {
      await Operator.deleteMany({ generation }).catch(() => {}); // no dejar una generacion huerfana a medias
      throw err;
    }
    await DirectoryState.findOneAndUpdate({ _id: "directory" }, { currentGeneration: generation, refreshedAt: now, count: operators.length }, { upsert: true });
    await Operator.deleteMany({ generation: { $ne: generation } }).catch(() => {});
    return { generation, count: operators.length };
  }

  async findById(generation, operatorId) {
    return Operator.findOne({ generation, operatorId }).lean();
  }

  /** Puede haber varios operadores con el mismo nombre (el directorio es compartido): devuelve todos. */
  async findByName(generation, name) {
    return Operator.find({ generation, nameKey: nameKey(name) }).lean();
  }

  async list(generation) {
    return Operator.find({ generation }).sort({ name: 1 }).lean();
  }
}

module.exports = { OperatorRepository, nameKey };
