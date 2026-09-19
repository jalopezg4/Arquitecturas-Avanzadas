const mongoose = require("mongoose");

/** Puntero al directorio VIGENTE (una sola fila). Cambiarlo es la unica operacion que "publica" un refresco. */
const directoryStateSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "directory" },
    currentGeneration: { type: String, required: true },
    refreshedAt: { type: Date, required: true },
    count: { type: Number, required: true },
  },
  { versionKey: false }
);

module.exports = mongoose.model("DirectoryState", directoryStateSchema);
