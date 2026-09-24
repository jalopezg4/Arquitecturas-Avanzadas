const crypto = require("crypto");
const logger = require("../tracing/logger");
const { ValidationError } = require("./DocumentService");

// Forma de una direccion unica. El formato que emite ms-identidad es `<documento>-<8 hex>@carpetacolombia.co`, pero
// aqui solo se comprueba que sea una direccion de correo plausible: atar el formato exacto haria que un cambio en
// ms-identidad rompiera este servicio en silencio. Quien decide si existe es la busqueda, no la expresion regular.
const DIRECCION_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const MAX_DIRECCION = 200;
// Clave de idempotencia de la entidad. Caben UUID, ULID y claves propias; se exige longitud suficiente para que
// identifique de verdad un envio y no colisione por accidente entre envios distintos de la misma institucion.
const ENVIO_ID_RE = /^[A-Za-z0-9_.:-]{8,100}$/;

/** La direccion unica no corresponde a ningun ciudadano de este operador. */
class DestinatarioNoEncontradoError extends Error {
  constructor() {
    // Mismo mensaje para "no existe" y para "formato invalido": no se confirma ni se niega quien esta afiliado aqui.
    super("no hay ningun ciudadano con esa direccion unica en este operador");
    this.name = "DestinatarioNoEncontradoError";
  }
}

/** Ese `envioId` ya se uso para OTRO envio (otro contenido u otro destinatario): no se pisa ni se duplica nada. */
class EnvioConflictError extends Error {
  constructor(documentoId) {
    super("ese envioId ya se uso para un envio distinto (otro contenido u otro destinatario)");
    this.name = "EnvioConflictError";
    this.documentoId = documentoId;
  }
}

/**
 * HU-10 (RF-11): recepcion de un documento enviado por una ENTIDAD EMISORA a la carpeta de un ciudadano.
 *
 * Se diferencia de HU-03 (el ciudadano carga lo suyo) en quien actua y en como se nombra al destinatario:
 *
 *                      HU-03 (ciudadano)            HU-10 (entidad emisora)
 *   actor              el propio ciudadano          la institucion (token institucional, ADR-07)
 *   destinatario       :id de la ruta (= su token)  su DIRECCION UNICA, resuelta aqui
 *   estado             temporal                     certificado (ya viene firmado por la entidad)
 *   cuota (RNF-04)     consume                      NO consume
 *   bitacora           actor = dueno                actor != dueno, con delegated: true
 *
 * Es una FACHADA delgada sobre DocumentService.upload(): resuelve al destinatario, aplica la idempotencia y delega.
 * Todo lo demas -- validar el PDF, subir al storage, compensar si algo falla a medias, publicar el evento -- es
 * exactamente el mismo camino que ya usa HU-03, sin duplicar una linea.
 *
 * El `ciudadanoId` NUNCA llega en la peticion: solo se obtiene resolviendo la direccion unica contra el modelo de
 * lectura local (`Folder.direccionUnica`), alimentado por el evento `ciudadano.registrado`. No hay ninguna llamada
 * REST a ms-identidad (ADR-01 y matriz de degradacion: este servicio recibe documentos aunque ms-identidad este caido).
 *
 * IDEMPOTENCIA. La entidad elige un `envioId` por envio. Un reintento (el cliente no vio la respuesta) no puede
 * dejar dos documentos: se comprueba antes de subir nada y, ademas, un indice UNICO `(emisorInstitutionId, envioId)`
 * cierra la carrera entre dos peticiones simultaneas. Reintento identico -> el MISMO documento; mismo `envioId` con
 * otro contenido u otro destinatario -> conflicto explicito, nunca se devuelve en silencio el documento anterior.
 */
class InboundDocumentService {
  constructor({ documentService, documentRepository, folderRepository, maxInboundBytes }) {
    this.documentService = documentService;
    this.documentRepository = documentRepository;
    this.folderRepository = folderRepository;
    this.maxInboundBytes = maxInboundBytes;
  }

  /** Decide que hacer ante un `envioId` que ya existe: mismo envio (idempotente) o conflicto. */
  _resolveExisting(existing, { ciudadanoId, sha256 }) {
    const mismoEnvio = existing.sha256 === sha256 && existing.ciudadanoId === ciudadanoId;
    if (!mismoEnvio) throw new EnvioConflictError(String(existing._id));
    logger.info("documento.recepcion_duplicada", { note: "mismo envioId y mismo contenido: no se crea otro documento" });
    return { documentoId: String(existing._id), ciudadanoId: existing.ciudadanoId, duplicado: true };
  }

  /**
   * @param {object} input
   * @param {string} input.destinatario   direccion unica del ciudadano (NUNCA su id interno)
   * @param {string} input.envioId        clave de idempotencia que elige la entidad
   * @param {{id: string, verificada: boolean}} input.emisor  entidad autenticada; sale del token, no del cuerpo
   * @param {{buffer: Buffer, mimetype: string}} input.file
   * @param {{titulo: string, entidadAvaladora: string, fecha: string}} input.metadata
   * @returns {Promise<{documentoId: string, ciudadanoId: string, duplicado: boolean}>}
   * @throws {DestinatarioNoEncontradoError} la direccion no corresponde a ningun ciudadano
   * @throws {EnvioConflictError} el envioId ya se uso para otro envio
   * @throws {ValidationError|UnsupportedMediaTypeError|PayloadTooLargeError|StorageUnavailableError} igual que HU-03
   */
  async receive({ destinatario, envioId, emisor, file, metadata } = {}) {
    if (!emisor || typeof emisor.id !== "string" || !emisor.id) throw new ValidationError("emisor es requerido");
    if (typeof envioId !== "string" || !ENVIO_ID_RE.test(envioId)) {
      throw new ValidationError("envioId es requerido (8 a 100 caracteres: letras, numeros, . : _ -)");
    }
    if (typeof destinatario !== "string" || !destinatario.trim()) throw new ValidationError("destinatario es requerido");
    const direccion = destinatario.trim();
    if (direccion.length > MAX_DIRECCION || !DIRECCION_RE.test(direccion)) throw new DestinatarioNoEncontradoError();

    const carpeta = await this.folderRepository.findByDireccionUnica(direccion);
    if (!carpeta) {
      // Sin ciudadano no hay recurso sobre el que auditar un acceso; el intento queda en el log, sin la direccion.
      logger.warn("documento.destinatario_no_encontrado", { emisorInstitutionId: emisor.id });
      throw new DestinatarioNoEncontradoError();
    }

    // Huella del contenido: decide si un `envioId` repetido es el mismo envio o uno distinto. Si el archivo no es
    // utilizable, no se calcula nada: la validacion de `upload()` dara el error que corresponde.
    const sha256 = file && Buffer.isBuffer(file.buffer) ? crypto.createHash("sha256").update(file.buffer).digest("hex") : null;

    if (sha256) {
      const existing = await this.documentRepository.findByEnvio(emisor.id, envioId);
      // Camino rapido: un reintento no vuelve a subir el archivo al storage.
      if (existing) return this._resolveExisting(existing, { ciudadanoId: carpeta.ciudadanoId, sha256 });
    }

    let result;
    try {
      result = await this.documentService.upload({
        ciudadanoId: carpeta.ciudadanoId, // el DUENO del documento es el ciudadano, no la entidad
        file,
        metadata,
        estado: "certificado", // ya viene firmado por la entidad: no pasa por `temporal` ni consume cuota (RNF-04)
        extra: { origen: "entidad", emisorInstitutionId: emisor.id, envioId },
        actor: { id: emisor.id, tipo: "entidad", delegated: true, action: "documento.recibir" },
        maxBytes: this.maxInboundBytes, // limite propio de la recepcion institucional
      });
    } catch (err) {
      // Dos peticiones simultaneas con el mismo envioId: el indice unico deja pasar UNA. La otra llega aqui con el
      // objeto del storage ya borrado por la compensacion de `upload()`, asi que solo queda resolver cual gano.
      if (!err || err.code !== 11000) throw err;
      const existing = await this.documentRepository.findByEnvio(emisor.id, envioId);
      if (!existing) throw err; // el choque fue con otro indice: no es cosa de la idempotencia
      return this._resolveExisting(existing, { ciudadanoId: carpeta.ciudadanoId, sha256 });
    }

    logger.info("documento.recibido", { emisorInstitutionId: emisor.id }); // sin titulo ni direccion del ciudadano
    // La URL prefirmada NO se devuelve: la entidad entrego el documento, no gana acceso de lectura a una carpeta ajena.
    return { documentoId: result.documentoId, ciudadanoId: carpeta.ciudadanoId, duplicado: false };
  }
}

module.exports = { InboundDocumentService, DestinatarioNoEncontradoError, EnvioConflictError, DIRECCION_RE, ENVIO_ID_RE, MAX_DIRECCION };
