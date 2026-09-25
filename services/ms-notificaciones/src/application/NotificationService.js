const logger = require("../tracing/logger");
const { PermanentError } = require("../infrastructure/EventConsumer");

/** Texto que viene de un ciudadano y va a un correo: sin saltos de linea ni caracteres de control (evita inyectar encabezados). */
function clean(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Avisos por correo (RF-21). Cada aviso se manda UNA sola vez aunque el evento llegue repetido o en paralelo:
 *   1. se RECLAMA el aviso de forma atomica (clave unica por evento)   -> solo un proceso continua
 *   2. se envia                                                        -> si falla, queda `fallido` y el mensaje se reintenta
 *   3. se marca `enviado`
 * El destinatario sale del contacto local (copia de ciudadano.registrado): este servicio no consulta a nadie.
 */
class NotificationService {
  constructor({ contactRepository, notificationRepository, emailSender, operatorName = "MiFolio", staleClaimMs = 60000, now = () => new Date() }) {
    this.contacts = contactRepository;
    this.notifications = notificationRepository;
    this.emailSender = emailSender;
    this.operatorName = clean(operatorName, 60);
    this.staleClaimMs = staleClaimMs;
    this.now = now;
  }

  async _deliver({ eventKey, tipo, ciudadanoId, to, subject, text }) {
    const claim = await this.notifications.claim(eventKey, { tipo, ciudadanoId }, this.now(), this.staleClaimMs);
    if (!claim.owner) {
      logger.info("notificacion.duplicada", { tipo, estado: claim.estado });
      return { sent: false, duplicate: true };
    }
    try {
      await this.emailSender.send({ to, subject, text });
    } catch (err) {
      await this.notifications.markFailed(eventKey, err.message).catch((e) => logger.error("notificacion.no_se_pudo_marcar_fallida", { err: e }));
      logger.error("notificacion.envio_fallido", { tipo, err });
      throw err; // fallo transitorio: el consumidor devuelve el mensaje a la cola y se reintenta
    }
    await this.notifications.markSent(eventKey, subject, this.now());
    logger.info("notificacion.enviada", { tipo });
    return { sent: true, duplicate: false };
  }

  /** ciudadano.registrado (HU-01): guarda a quien avisar y le da la bienvenida (una sola vez por ciudadano). */
  async onCitizenRegistered({ ciudadanoId, nombre, correo, direccionUnica, telefono }) {
    await this.contacts.upsert({ ciudadanoId, nombre: clean(nombre, 120), correo: clean(correo, 200), telefono: telefono ? clean(telefono, 20) : null });
    return this._deliver({
      eventKey: `ciudadano.registrado:${ciudadanoId}`,
      tipo: "bienvenida",
      ciudadanoId,
      to: clean(correo, 200),
      subject: `Bienvenida a ${this.operatorName}: tu carpeta ciudadana esta lista`,
      text: [
        `Hola ${clean(nombre, 120)},`,
        "",
        `Tu carpeta ciudadana en ${this.operatorName} ya esta activa.`,
        ...(direccionUnica ? [`Tu direccion de correo institucional es: ${clean(direccionUnica, 120)}`] : []),
        "",
        "Este es un aviso automatico; no respondas a este correo.",
      ].join("\n"),
    });
  }

  /** documento.cargado (HU-03): confirma al ciudadano que su documento quedo en la carpeta. */
  async onDocumentUploaded({ eventId, ciudadanoId, titulo, entidadAvaladora, estado, cargadoEn }) {
    const contact = await this.contacts.find(ciudadanoId);
    // Sin contacto no hay a quien escribir y reintentar no lo arregla (el contacto llega por otro evento): fallidos.
    if (!contact) throw new PermanentError("no hay contacto para el ciudadano (ciudadano.registrado no procesado)");

    const title = clean(titulo, 120);
    return this._deliver({
      eventKey: `documento.cargado:${eventId}`,
      tipo: "documento_cargado",
      ciudadanoId,
      to: contact.correo,
      subject: `Tu documento "${title}" fue cargado en tu carpeta`,
      text: [
        `Hola ${clean(contact.nombre, 120)},`,
        "",
        `Tu documento "${title}" (avalado por ${clean(entidadAvaladora, 120)}) se cargo en tu carpeta ciudadana.`,
        `Estado: ${estado === "certificado" ? "certificado" : "no certificado (temporal)"}. Puedes autenticarlo para certificarlo oficialmente.`,
        `Fecha de carga: ${clean(cargadoEn, 40)}`,
        "",
        "Este es un aviso automatico; no respondas a este correo.",
      ].join("\n"),
    });
  }
}

module.exports = { NotificationService, clean };
