/**
 * Contenido del evento `documento.cargado`. Lo usan la carga (DocumentService) y el reenvio (EventReconciler): tienen
 * que producir EXACTAMENTE el mismo mensaje para un mismo documento.
 *
 * `eventId` es deterministico (el id del documento), no aleatorio: si el evento llega dos veces (la confirmacion del
 * broker se perdio y luego se reenvio), ms-notificaciones lo reconoce como el mismo y envia UN solo correo.
 */
function documentoCargadoPayload(doc) {
  return {
    eventId: doc._id.toString(),
    documentoId: doc._id.toString(),
    ciudadanoId: doc.ciudadanoId,
    titulo: doc.titulo,
    entidadAvaladora: doc.entidadAvaladora,
    estado: doc.estado,
    cargadoEn: doc.createdAt.toISOString(),
  };
}

module.exports = { documentoCargadoPayload };
