/**
 * Contenido del evento `solicitud.creada` (HU-06.3, PASO 3.2). Lo usan la creacion (SolicitudService) y el
 * reenvio (SolicitudEventReconciler): tienen que producir EXACTAMENTE el mismo mensaje para una misma solicitud
 * -- mismo criterio que `documentoCargadoPayload` en events.js para `documento.cargado`.
 *
 * `eventId` es deterministico (el id de la solicitud), no aleatorio: si el evento llega dos veces (la
 * confirmacion del broker se perdio y luego se reenvio), ms-notificaciones lo reconoce como el mismo y no manda
 * un aviso duplicado.
 *
 * Deliberadamente NO incluye `institutionId`: ms-notificaciones solo necesita saber A QUIEN avisar
 * (`ciudadanoId`), no quien pidio el documento -- ver diseno de HU-06.3, PASO 3 (riesgo G: la notificacion usa
 * exclusivamente `ciudadanoId` del propio evento).
 */
function solicitudCreadaPayload(solicitud) {
  return {
    eventId: solicitud._id.toString(),
    solicitudId: solicitud._id.toString(),
    ciudadanoId: solicitud.ciudadanoId,
    descripcion: solicitud.descripcion,
    creadaEn: solicitud.createdAt.toISOString(),
  };
}

module.exports = { solicitudCreadaPayload };
