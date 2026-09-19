const mongoose = require("mongoose");

/**
 * Copia LOCAL de un operador del directorio de GovCarpeta (ADR-03: cada servicio posee sus datos y no consulta al
 * centralizador en cada operacion). Se guarda por GENERACION: un refresco escribe una generacion nueva completa y solo
 * al final cambia el puntero (DirectoryState), asi los lectores nunca ven un directorio a medias.
 */
const operatorSchema = new mongoose.Schema(
  {
    generation: { type: String, required: true },
    operatorId: { type: String, required: true },
    name: { type: String, required: true },
    // Clave de busqueda por nombre: minusculas, sin espacios repetidos (el directorio real trae espacios y casing dispares).
    nameKey: { type: String, required: true },
    // Direccion de transferencia publicada por ese operador; solo 16 de 71 la tenian el 2026-09-19.
    transferApiUrl: { type: String, default: null },
    participants: { type: [String], default: [] },
  },
  { timestamps: true }
);
operatorSchema.index({ generation: 1, operatorId: 1 }, { unique: true });
operatorSchema.index({ generation: 1, nameKey: 1 });

module.exports = mongoose.model("Operator", operatorSchema);
