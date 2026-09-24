const mongoose = require("mongoose");

const ESTADOS = ["temporal", "certificado"];
// Quien puso el documento en la carpeta (HU-10). No es lo mismo que el DUENO: el dueno es siempre el ciudadano.
const ORIGENES = ["ciudadano", "entidad"];

/**
 * Metadatos de un documento de la carpeta (RF-19, RF-20). El archivo NO esta aqui: vive en el object storage y
 * solo se guarda su clave (`storageKey`). Un documento `temporal` cuenta para la cuota del ciudadano; uno
 * `certificado` (recibido de una entidad emisora o autenticado en GovCarpeta) no.
 */
const documentSchema = new mongoose.Schema(
  {
    ciudadanoId: { type: String, required: true, index: true },
    titulo: { type: String, required: true },
    entidadAvaladora: { type: String, required: true },
    fecha: { type: Date, required: true },
    estado: { type: String, enum: ESTADOS, default: "temporal", required: true },
    storageKey: { type: String, required: true, unique: true },
    mimeType: { type: String, required: true },
    tamanoBytes: { type: Number, required: true },
    // Huella del contenido: permite detectar alteraciones y sera la base de la autenticacion (HU-04).
    sha256: { type: String, required: true },
    // RF-30: si la carga sustituye provisionalmente un documento que una entidad pidio (HU-06.3/06.4).
    solicitudId: { type: String, default: null },
    // Procedencia (HU-10): quien puso el documento en la carpeta.
    //   "ciudadano" -> lo cargo su dueno (HU-03)
    //   "entidad"   -> lo entrego una entidad emisora a la direccion unica del ciudadano (HU-10, RF-11)
    origen: { type: String, enum: ORIGENES, default: "ciudadano", required: true },
    // Id de la institucion que lo entrego. Sale SIEMPRE del token institucional firmado, nunca del cuerpo de la
    // peticion. `entidadAvaladora` es texto de presentacion y es autodeclarado; este campo es el dato confiable.
    emisorInstitutionId: { type: String, default: null, index: true },
    // Clave de idempotencia que elige la entidad emisora (HU-10): identifica UN envio suyo. Un cliente maquina
    // reintenta por diseno (un timeout no significa que no se haya guardado), y un certificado no consume cuota:
    // sin esto, un reintento dejaria dos diplomas identicos en la carpeta del ciudadano.
    envioId: { type: String, default: null },
    // true cuando el broker confirmo el evento DocumentoCargado; false = requiere reconciliacion.
    eventoPublicado: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// UNICO por (institucion, envio): dos peticiones con el mismo envioId de la misma entidad no pueden crear dos
// documentos, ni siquiera si llegan a la vez. Parcial porque la carga del ciudadano (HU-03) no lleva ninguno de
// los dos campos y un indice normal haria chocar entre si a todos esos documentos con `null`.
documentSchema.index(
  { emisorInstitutionId: 1, envioId: 1 },
  { unique: true, partialFilterExpression: { emisorInstitutionId: { $type: "string" }, envioId: { $type: "string" } } }
);

module.exports = mongoose.model("Document", documentSchema);
module.exports.ESTADOS = ESTADOS;
module.exports.ORIGENES = ORIGENES;
