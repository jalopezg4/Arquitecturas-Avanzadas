const Citizen = require("../domain/Citizen");

/** Copia local del ciudadano (HU-05c). Idempotente: una reentrega de `ciudadano.registrado` no duplica ni falla. */
class CitizenRepository {
  async upsert({ ciudadanoId, documento, nombre, correo, direccionUnica, direccion }) {
    const set = { documento, nombre, correo };
    if (direccionUnica) set.direccionUnica = direccionUnica;
    if (direccion) set.direccion = direccion;
    await Citizen.updateOne({ ciudadanoId }, { $set: set }, { upsert: true });
  }

  async find(ciudadanoId) {
    return Citizen.findOne({ ciudadanoId }).lean();
  }

  async findByDocumento(documento) {
    return Citizen.findOne({ documento }).lean();
  }

  async remove(ciudadanoId) {
    await Citizen.deleteOne({ ciudadanoId });
  }
}

module.exports = CitizenRepository;
