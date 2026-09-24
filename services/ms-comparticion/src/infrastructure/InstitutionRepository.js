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

  /**
   * ADR-07: registra un intento fallido de autenticacion y, al alcanzar `maxAttempts`, fija el bloqueo, todo en UNA
   * operacion atomica (pipeline de actualizacion). Con un leer-modificar-guardar, N intentos en paralelo contarian
   * como uno solo y el atacante se saltaria el limite. Misma politica que CitizenRepository (HU-02).
   */
  async registerFailedAttempt(id, { maxAttempts, lockUntil }) {
    return Institution.findByIdAndUpdate(
      id,
      [
        { $set: { intentosFallidos: { $add: [{ $ifNull: ["$intentosFallidos", 0] }, 1] } } },
        { $set: { bloqueadoHasta: { $cond: [{ $gte: ["$intentosFallidos", maxAttempts] }, lockUntil, "$bloqueadoHasta"] } } },
      ],
      { new: true }
    );
  }

  /**
   * Aceptacion ATOMICA de una autenticacion con contrasena correcta: solo prospera si la entidad NO esta bloqueada
   * en este instante, y en la misma operacion pone el contador en cero. Sin esto, una autenticacion que empezo antes
   * de que otros intentos bloquearan la cuenta usaria un estado ya viejo (la verificacion Argon2 tarda) y entraria
   * igual. Devuelve la entidad actualizada, o null si ya no se puede aceptar.
   */
  async acceptAuthentication(id, now) {
    return Institution.findOneAndUpdate(
      { _id: id, $or: [{ bloqueadoHasta: null }, { bloqueadoHasta: { $lte: now } }] },
      { intentosFallidos: 0, bloqueadoHasta: null },
      { new: true }
    ).lean();
  }

  /** Bloqueo ya vencido: contador en cero y sin bloqueo. */
  async resetFailedAttempts(id) {
    return Institution.findByIdAndUpdate(id, { intentosFallidos: 0, bloqueadoHasta: null }, { new: true }).lean();
  }

  /**
   * ADR-07: cambia el estado de verificacion de la entidad, de forma CONDICIONAL y atomica: solo escribe si el
   * estado actual es distinto del pedido. Asi la operacion es idempotente y dos ejecuciones simultaneas del
   * script no se pisan ni duplican la escritura.
   *
   * @returns {{status: "aplicada"|"sin-cambios"|"no-encontrada", institution: object|null}}
   *   - "aplicada":     estaba en el otro estado y se cambio; `institution` es como quedo.
   *   - "sin-cambios":  ya estaba en el estado pedido; `institution` es como esta (no se toco nada).
   *   - "no-encontrada": no hay ninguna entidad con ese NIT.
   */
  async setVerification(nit, { verificada, decididaEn, decididaPor, motivo }) {
    const updated = await Institution.findOneAndUpdate(
      { nit, verificada: !verificada },
      { verificada, verificadaEn: decididaEn, verificadaPor: decididaPor, motivoVerificacion: motivo },
      { new: true }
    ).lean();
    if (updated) return { status: "aplicada", institution: updated };

    const current = await Institution.findOne({ nit }).lean();
    if (!current) return { status: "no-encontrada", institution: null };
    return { status: "sin-cambios", institution: current };
  }
}

module.exports = { InstitutionRepository, DuplicateInstitutionError };
