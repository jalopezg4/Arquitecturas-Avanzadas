const mongoose = require("mongoose");
const logger = require("../tracing/logger");
const { autenticacionSolicitadaPayload } = require("./events");
const { CarpetaEnTransferenciaError } = require("../domain/errors");

class DocumentoNoEncontradoError extends Error {
  constructor() {
    super("documento no encontrado");
    this.name = "DocumentoNoEncontradoError";
  }
}
class DocumentoAjenoError extends Error {
  constructor() {
    super("solo el dueno del documento puede solicitar su autenticacion");
    this.name = "DocumentoAjenoError";
  }
}
class DocumentoNoDisponibleError extends Error {
  constructor() {
    super("el documento no esta disponible para autenticacion");
    this.name = "DocumentoNoDisponibleError";
  }
}
class CedulaNoRegistradaError extends Error {
  constructor() {
    super("la carpeta aun no tiene registrada la identificacion del ciudadano; intenta de nuevo en unos minutos");
    this.name = "CedulaNoRegistradaError";
  }
}

const ROUTING_KEY = "documento.autenticacion_solicitada";

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * HU-04: autenticacion de un documento a traves de GovCarpeta, del lado de ms-documentos (dueno del estado).
 *
 * `request()` NO habla con GovCarpeta: marca el documento `en autenticacion`, publica
 * `documento.autenticacion_solicitada` y responde de inmediato (RNF-10). ms-autenticacion hace el resto y devuelve
 * el resultado por evento.
 *
 * Orden deliberado:
 *   1. el documento existe y es del ciudadano del token      -> 404 / 403 (bitacora `no_es_dueno`)
 *   2. la carpeta tiene la cedula (idCitizen de GovCarpeta)   -> 409, SIN cambiar el estado
 *   3. temporal -> en autenticacion, atomico                  -> 400 si no estaba temporal
 *   4. publicar el evento                                     -> si falla NO falla la solicitud: lo reenvia el reconciliador
 */
class DocumentAuthenticationService {
  constructor({ documentRepository, folderRepository, eventPublisher, auditLogger, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    this.documentRepository = documentRepository;
    this.folderRepository = folderRepository;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  async request({ ciudadanoId, documentoId }) {
    // Un id con forma invalida es, para quien pregunta, lo mismo que uno inexistente.
    if (typeof documentoId !== "string" || !mongoose.isValidObjectId(documentoId)) throw new DocumentoNoEncontradoError();

    const actual = await this.documentRepository.findById(documentoId);
    if (!actual) throw new DocumentoNoEncontradoError();
    if (actual.ciudadanoId !== ciudadanoId) {
      await this._audit(ciudadanoId, documentoId, actual.ciudadanoId, "rechazo", "no_es_dueno");
      throw new DocumentoAjenoError();
    }

    // Solo PDF: un escaneo importado de otro operador (HU-05c) no se puede autenticar aqui.
    if (actual.mimeType && actual.mimeType !== "application/pdf") {
      await this._audit(ciudadanoId, documentoId, ciudadanoId, "rechazo", "tipo_no_autenticable");
      throw new DocumentoNoDisponibleError();
    }

    const folder = await this.folderRepository.get(ciudadanoId);
    if (folder && folder.transferenciaId) throw new CarpetaEnTransferenciaError();
    if (!folder || !folder.documento) {
      await this._audit(ciudadanoId, documentoId, ciudadanoId, "rechazo", "sin_cedula");
      throw new CedulaNoRegistradaError();
    }

    const doc = await this.documentRepository.startAuthentication(documentoId, ciudadanoId, this.now());
    if (!doc) {
      await this._audit(ciudadanoId, documentoId, ciudadanoId, "rechazo", "estado_no_temporal");
      throw new DocumentoNoDisponibleError();
    }

    await this.publish(doc, folder.documento);
    await this._audit(ciudadanoId, documentoId, ciudadanoId, "exito", undefined, { intento: doc.autenticacionIntento });
    return { documentoId: String(doc._id), estado: doc.estado };
  }

  /** Publica la solicitud del intento vigente. Si el broker no confirma a tiempo queda pendiente para el reconciliador. */
  async publish(doc, documento) {
    const payload = autenticacionSolicitadaPayload(doc, documento);
    try {
      await withTimeout(this.eventPublisher.publish(ROUTING_KEY, payload), this.eventPublishTimeoutMs);
      await this.documentRepository.markAuthRequestPublished(doc._id, doc.autenticacionIntento);
      return true;
    } catch (err) {
      logger.error("documento.autenticacion_evento_no_publicado", { documentoId: payload.documentoId, note: "lo reenvia el reconciliador", err });
      return false;
    }
  }

  /**
   * `documento.autenticado` (desde ms-autenticacion): el documento pasa a `certificado` con la fecha de autenticacion
   * y, como ya no es "no certificado", devuelve su cupo de la cuota (RNF-04). La transicion es condicional al intento
   * vigente: un evento repetido o de un intento viejo no hace nada y el cupo nunca se libera dos veces.
   */
  async onAuthenticated({ documentoId, intento, autenticadoEn }) {
    const fecha = autenticadoEn && !Number.isNaN(Date.parse(autenticadoEn)) ? new Date(autenticadoEn) : this.now();
    const doc = await this.documentRepository.completeAuthentication(documentoId, intento, fecha);
    if (!doc) {
      logger.info("documento.autenticacion_resultado_ignorado", { documentoId, intento, note: "repetido o de un intento anterior" });
      return { applied: false };
    }
    await this.folderRepository.releaseNonCertified(doc.ciudadanoId);
    logger.info("documento.certificado", { documentoId, intento });
    return { applied: true };
  }

  /** `documento.autenticacion_fallida`: vuelve a `temporal` (no queda colgado en "en autenticacion"); conserva su cupo. */
  async onAuthenticationFailed({ documentoId, intento, motivo }) {
    const doc = await this.documentRepository.revertAuthentication(documentoId, intento);
    if (!doc) {
      logger.info("documento.autenticacion_resultado_ignorado", { documentoId, intento, note: "repetido o de un intento anterior" });
      return { applied: false };
    }
    logger.warn("documento.autenticacion_fallida", { documentoId, intento, motivo });
    return { applied: true };
  }

  async _audit(ciudadanoId, documentoId, resourceOwner, outcome, reason, metadata) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({
        actor: String(ciudadanoId),
        actorType: "ciudadano",
        action: "documento.autenticar",
        resource: `documento:${documentoId}`,
        resourceOwner: String(resourceOwner),
        outcome,
        reason,
        metadata,
      });
    } catch (err) {
      logger.error("audit.write_failed", { action: "documento.autenticar", err });
    }
  }
}

module.exports = {
  DocumentAuthenticationService,
  DocumentoNoEncontradoError,
  DocumentoAjenoError,
  DocumentoNoDisponibleError,
  CedulaNoRegistradaError,
  AUTENTICACION_SOLICITADA: ROUTING_KEY,
};
