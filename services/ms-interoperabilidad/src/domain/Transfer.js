const mongoose = require("mongoose");

/**
 * Una transferencia de ciudadano entre operadores (HU-05c; entidad `Transferencia` del expediente, figura 9).
 *
 * SALIENTE (el ciudadano se va de este operador), estados:
 *   exportando              -> ms-documentos bloquea la carpeta y entrega las URLs de los documentos
 *   enviando                -> desafiliar en GovCarpeta + POST transferCitizen al destino
 *   esperando_confirmacion  -> el destino confirma via confirmAPI (plazo + reenvios)
 *   completada              -> confirmo con req_status 1: se borran los datos (ciudadano.transferido)
 *   fallida                 -> se compenso: re-registrado en GovCarpeta y carpeta desbloqueada
 *
 * ENTRANTE (el ciudadano llega desde otro operador), estados:
 *   importando              -> ms-documentos descarga los documentos
 *   registrando             -> ms-identidad crea al ciudadano y lo registra en GovCarpeta
 *   confirmando             -> POST al confirmAPI del origen
 *   completada / rechazada  -> se confirmo 1 / se revirtio lo importado y se confirmo 0
 *
 * `activa` marca las que no terminaron: un indice unico PARCIAL impide dos transferencias vivas del mismo ciudadano.
 */
const TIPOS = ["saliente", "entrante"];
const ESTADOS_SALIENTE = ["exportando", "enviando", "esperando_confirmacion", "completada", "fallida"];
const ESTADOS_ENTRANTE = ["importando", "registrando", "confirmando", "completada", "rechazada"];
const ESTADOS = [...new Set([...ESTADOS_SALIENTE, ...ESTADOS_ENTRANTE])];

const documentoSchema = new mongoose.Schema(
  {
    clave: { type: String, required: true }, // llave en urlDocuments (URL1, URL2...)
    url: { type: String, required: true },
    titulo: { type: String, default: null },
    entidadAvaladora: { type: String, default: null },
    fecha: { type: String, default: null },
    estado: { type: String, default: null }, // "certificado" | "temporal" (metadatos opcionales del protocolo)
    sha256: { type: String, default: null },
  },
  { _id: false }
);

const transferSchema = new mongoose.Schema(
  {
    tipo: { type: String, enum: TIPOS, required: true },
    estado: { type: String, enum: ESTADOS, required: true },
    activa: { type: Boolean, default: true },
    // Ciudadano en ESTE operador (saliente: el que se va; entrante: el id que se le asigna al llegar).
    ciudadanoId: { type: String, required: true },
    documento: { type: Number, required: true }, // cedula: `id` del protocolo y de GovCarpeta
    nombre: { type: String, default: null },
    correo: { type: String, default: null },
    direccionUnica: { type: String, default: null },
    direccion: { type: String, default: null }, // direccion fisica: registerCitizen la exige
    documentos: { type: [documentoSchema], default: [] },

    // SALIENTE
    operadorDestinoId: { type: String, default: null },
    operadorDestinoNombre: { type: String, default: null },
    destinoUrl: { type: String, default: null },
    // Token aleatorio que viaja en NUESTRO confirmAPI (?t=...): sin el, cualquiera que conozca una cedula podria
    // confirmar una transferencia ajena y hacernos borrar al ciudadano. Se guarda porque cada reenvio usa la misma URL;
    // nunca se registra en logs ni sale de este servicio salvo hacia el destino.
    confirmToken: { type: String, default: null },
    desafiliadoEnGovCarpeta: { type: Boolean, default: false },
    // Compensacion: el ciudadano ya se volvio a afiliar a NOSOTROS en GovCarpeta.
    reafiliado: { type: Boolean, default: false },
    enviosRealizados: { type: Number, default: 0 },

    // ENTRANTE
    confirmApi: { type: String, default: null }, // la del ORIGEN
    // Firma del pedido recibido: un reintento identico del origen no crea otra transferencia.
    huellaPedido: { type: String, default: null },

    // Control de la saga
    motivo: { type: String, default: null },
    // true mientras se esta deshaciendo (compensacion en curso): el barrido la retoma si algo fallo a mitad.
    fallando: { type: Boolean, default: false },
    // Cuando hay que volver a mirar esta transferencia (reenvio, plazo vencido). La revisa TransferSweeper.
    revisarEn: { type: Date, default: null },
    finalizadaEn: { type: Date, default: null },
  },
  { timestamps: true }
);

transferSchema.index({ tipo: 1, ciudadanoId: 1 }, { unique: true, partialFilterExpression: { activa: true } });
transferSchema.index({ tipo: 1, documento: 1 }, { unique: true, partialFilterExpression: { activa: true } });
transferSchema.index({ activa: 1, revisarEn: 1 });

module.exports = mongoose.model("Transfer", transferSchema);
module.exports.TIPOS = TIPOS;
module.exports.ESTADOS_SALIENTE = ESTADOS_SALIENTE;
module.exports.ESTADOS_ENTRANTE = ESTADOS_ENTRANTE;
