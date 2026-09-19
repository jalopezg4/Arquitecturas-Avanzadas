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

  /**
   * Aceptacion ATOMICA de un login con password correcto: solo prospera si la cuenta sigue activa y NO bloqueada
   * en este instante, y en la misma operacion pone el contador en cero. Sin esto, un login que empezo antes de que
   * otros intentos bloquearan la cuenta usaria un estado ya viejo (la verificacion Argon2 tarda) y entraria igual.
   * Devuelve el ciudadano actualizado, o null si ya no se puede aceptar.
   */
  async acceptLogin(id, now) {
    return Citizen.findOneAndUpdate(
      { _id: id, estado: "activo", $or: [{ bloqueadoHasta: null }, { bloqueadoHasta: { $lte: now } }] },
      { intentosFallidos: 0, bloqueadoHasta: null },
      { new: true }
    );
  }

  /** Login exitoso, o bloqueo ya vencido: contador en cero y sin bloqueo. */
  async resetLoginAttempts(id) {
    return Citizen.findByIdAndUpdate(id, { intentosFallidos: 0, bloqueadoHasta: null }, { new: true });
  }

  /** Borra al ciudadano SOLO si sigue pendiente (nunca a uno ya activo). */
  async deletePending(id) {
    return Citizen.deleteOne({ _id: id, estado: "pendiente" });
  }

  async markActive(id) {
    const citizen = await Citizen.findByIdAndUpdate(id, { estado: "activo" }, { new: true });
    if (!citizen) throw new Error("Ciudadano no encontrado al marcar activo");
    return citizen;
  }
}

module.exports = CitizenRepository;
