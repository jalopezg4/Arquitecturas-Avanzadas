const mongoose = require("mongoose");

/**
 * Cuota de la carpeta de un ciudadano: QUE documentos no certificados ocupan cupo (`cupos`) y cuantos son
 * (`noCertificados`, siempre igual a `cupos.length`). Existe como documento aparte (y no como `countDocuments`) para
 * poder reservar cupo de forma ATOMICA: contar y luego insertar deja pasar varias cargas simultaneas por encima del
 * limite.
 *
 * El cupo se guarda POR DOCUMENTO (y no solo como contador) para que reservar y liberar sean IDEMPOTENTES: liberar
 * dos veces el cupo del mismo documento no hace nada la segunda vez, asi que cualquier reintento (un consumidor que
 * reprocesa un evento, una compensacion repetida) puede volver a pedirlo sin descuadrar la cuota (RNF-04).
 *
 * Ademas es el MODELO DE LECTURA local del ciudadano en este servicio (HU-10): guarda su `direccionUnica`, que
 * llega en el evento `ciudadano.registrado` (ADR-01: cada servicio posee sus datos y ninguno consulta la base ni
 * la API de otro). Es el mismo patron que `Contact` en ms-notificaciones.
 */
const folderSchema = new mongoose.Schema(
  {
    ciudadanoId: { type: String, required: true, unique: true },
    noCertificados: { type: Number, default: 0, min: 0 },
    // Ids de los documentos que ocupan cupo. Un id entra ANTES de crear el documento (reserva), asi que puede haber
    // ids de cargas en curso; el QuotaReconciler devuelve los que quedaron sin documento.
    cupos: { type: [String], default: undefined },
    // Ultima vez que el QuotaReconciler reviso esta carpeta (las mas atrasadas se revisan primero).
    cuposRevisadosEn: { type: Date, default: null },
    // Direccion unica del ciudadano (HU-01), copia local. Es por donde una entidad emisora dirige un documento
    // (HU-10), nunca por el id interno. `null` mientras no haya llegado el evento que la trae.
    direccionUnica: { type: String, default: null },
    // Numero de documento (cedula) del ciudadano, copia local que llega en `ciudadano.registrado`. HU-04 lo necesita
    // porque GovCarpeta identifica al ciudadano por el (`idCitizen`). `null` en carpetas creadas por una carga antes
    // de recibir el evento: esas no pueden pedir autenticacion hasta que llegue.
    documento: { type: Number, default: null },
    // HU-05c: id de la transferencia que tiene la carpeta en SOLO LECTURA (null = se puede escribir). Mientras este
    // puesto no se carga, no se recibe ni se pide autenticar nada: lo nuevo no viajaria al operador destino.
    transferenciaId: { type: String, default: null },
    // HU-05c: ids de los documentos que la transferencia EXPORTO (se fija en la primera exportacion y no cambia).
    // Al confirmar el destino se borran SOLO estos: nada que no viajo se pierde.
    exportados: { type: [String], default: undefined },
  },
  { timestamps: true }
);

// UNICO pero solo entre las carpetas que ya tienen direccion: un indice `sparse` no serviria porque `null` cuenta
// como valor presente y varias carpetas sin direccion chocarian entre si.
folderSchema.index({ direccionUnica: 1 }, { unique: true, partialFilterExpression: { direccionUnica: { $type: "string" } } });

module.exports = mongoose.model("Folder", folderSchema);
