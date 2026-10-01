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

/**
 * Contenido del evento `documento.autenticacion_solicitada` (HU-04). Lo usan la solicitud y su reconciliador.
 *
 * `eventId` = `<documentoId>-auth-<intento>`: deterministico por intento (un reenvio del mismo intento es el mismo
 * evento) pero distinto entre intentos (pedir de nuevo tras un fallo no se confunde con un duplicado).
 * `documento` es la cedula (idCitizen de GovCarpeta) y `storageKey` la clave del objeto a exponer con URL prefirmada:
 * datos internos del bus, nunca se devuelven al ciudadano.
 */
function autenticacionSolicitadaPayload(doc, documento) {
  const documentoId = doc._id.toString();
  return {
    eventId: `${documentoId}-auth-${doc.autenticacionIntento}`,
    documentoId,
    ciudadanoId: doc.ciudadanoId,
    documento,
    titulo: doc.titulo,
    storageKey: doc.storageKey,
    intento: doc.autenticacionIntento,
    solicitadaEn: new Date(doc.autenticacionSolicitadaEn).toISOString(),
  };
}

module.exports = { documentoCargadoPayload, autenticacionSolicitadaPayload };
