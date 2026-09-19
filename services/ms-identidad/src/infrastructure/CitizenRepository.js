const Citizen = require("../domain/Citizen");

class CitizenRepository {
  async findByDocumento(documento) {
    return Citizen.findOne({ documento });
  }

  async findById(id) {
    return Citizen.findById(id);
  }

  async create(data) {
    // El indice unique de Mongoose sobre `direccionUnica` y `documento` es lo que
    // garantiza la unicidad a nivel de BD (HU-01 AC), no solo esta validacion en codigo.
    return Citizen.create(data);
  }

  /**
   * HU-02: registra un intento fallido y, al alcanzar `maxAttempts`, fija el bloqueo, todo en UNA
   * operacion atomica (pipeline de actualizacion). Con un leer-modificar-guardar, N intentos en
   * paralelo cuentan como uno solo y el atacante se saltaria el limite.
   */
  async registerFailedAttempt(id, { maxAttempts, lockUntil }) {
    return Citizen.findByIdAndUpdate(
      id,
      [
        { $set: { intentosFallidos: { $add: [{ $ifNull: ["$intentosFallidos", 0] }, 1] } } },
        { $set: { bloqueadoHasta: { $cond: [{ $gte: ["$intentosFallidos", maxAttempts] }, lockUntil, "$bloqueadoHasta"] } } },
      ],
      { new: true }
    );
  }

  /** Login exitoso, o bloqueo ya vencido: contador en cero y sin bloqueo. */
  async resetLoginAttempts(id) {
    return Citizen.findByIdAndUpdate(id, { intentosFallidos: 0, bloqueadoHasta: null }, { new: true });
  }

  async markActive(id) {
    const citizen = await Citizen.findByIdAndUpdate(id, { estado: "activo" }, { new: true });
    if (!citizen) throw new Error("Ciudadano no encontrado al marcar activo");
    return citizen;
  }
}

module.exports = CitizenRepository;
