const Citizen = require("../domain/Citizen");

class CitizenRepository {
  async findByDocumento(documento) {
    return Citizen.findOne({ documento });
  }

  async create(data) {
    // El indice unique de Mongoose sobre `direccionUnica` y `documento` es lo que
    // garantiza la unicidad a nivel de BD (HU-01 AC), no solo esta validacion en codigo.
    return Citizen.create(data);
  }

  async markActive(id) {
    const citizen = await Citizen.findByIdAndUpdate(id, { estado: "activo" }, { new: true });
    if (!citizen) throw new Error("Ciudadano no encontrado al marcar activo");
    return citizen;
  }
}

module.exports = CitizenRepository;
