const logger = require("../tracing/logger");

/**
 * HU-04: reenvia los `documento.autenticacion_solicitada` que no se pudieron publicar al pedirlos (broker caido o sin
 * confirmar): esos documentos quedan `en autenticacion` con `autenticacionEventoPublicado:false`. Sin este proceso se
 * quedarian colgados en ese estado para siempre.
 *
 * Mismo criterio que EventReconciler: solo toca solicitudes con al menos `minAgeMs` de antiguedad (una reciente puede
 * tener su publicacion en curso), es seguro en varias replicas (el `eventId` es deterministico por intento y
 * ms-autenticacion es idempotente) y un documento que falla no impide reenviar los demas. La publicacion en si la
 * hace DocumentAuthenticationService.publish(), la misma que usa la solicitud: el mensaje es identico.
 */
class AuthenticationRequestReconciler {
  // `timeoutMs`: cuanto puede seguir un documento `en autenticacion` con la solicitud ya publicada. Mas que la vigencia
  // de la URL (15 min): pasado ese tiempo GovCarpeta ya no puede leer el documento, asi que no hay resultado en camino.
  constructor({ documentRepository, folderRepository, authenticationService, minAgeMs = 60000, timeoutMs = 30 * 60 * 1000, batchSize = 50, now = () => new Date() }) {
    this.documentRepository = documentRepository;
    this.timeoutMs = timeoutMs;
    this.folderRepository = folderRepository;
    this.authenticationService = authenticationService;
    this.minAgeMs = minAgeMs;
    this.batchSize = batchSize;
    this.now = now;
    this._running = false;
    this._timer = null;
  }

  async reconcileOnce() {
    const olderThan = new Date(this.now().getTime() - this.minAgeMs);
    const docs = await this.documentRepository.findUnpublishedAuthRequests({ olderThan, limit: this.batchSize });
    let republished = 0;
    let failed = 0;
    for (const doc of docs) {
      const folder = await this.folderRepository.get(doc.ciudadanoId).catch(() => null);
      // La cedula se comprobo al pedir la autenticacion; si ya no esta, algo se borro por fuera: no se inventa.
      if (folder && folder.documento && (await this.authenticationService.publish(doc, folder.documento))) republished++;
      else failed++;
    }
    // Solicitudes publicadas que nunca tuvieron resultado: vuelven a temporal y el ciudadano recibe el aviso.
    let expired = 0;
    const vencidas = await this.documentRepository.findStaleAuthentications({ olderThan: new Date(this.now().getTime() - this.timeoutMs), limit: this.batchSize });
    for (const doc of vencidas) {
      try {
        if (await this.authenticationService.expire(doc)) expired++;
      } catch (err) {
        failed++;
        logger.error("documento.autenticacion_vencida_no_aplicada", { documentoId: String(doc._id), note: "se reintenta en la siguiente pasada", err });
      }
    }
    if (republished || failed || expired) logger.info("documento.autenticacion_reconciliacion", { reenviados: republished, vencidos: expired, fallidos: failed });
    return { republished, failed, expired };
  }

  start(intervalMs) {
    this.stop();
    this._timer = setInterval(async () => {
      if (this._running) return;
      this._running = true;
      try {
        await this.reconcileOnce();
      } catch (err) {
        logger.error("documento.autenticacion_reconciliacion_fallo", { err });
      } finally {
        this._running = false;
      }
    }, intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = AuthenticationRequestReconciler;
