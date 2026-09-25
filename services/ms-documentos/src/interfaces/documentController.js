const logger = require("../tracing/logger");
const { ValidationError, UnsupportedMediaTypeError, PayloadTooLargeError, QuotaExceededError, StorageUnavailableError } = require("../application/DocumentService");
const { DestinatarioNoEncontradoError, EnvioConflictError } = require("../application/InboundDocumentService");
const { SolicitudNotFoundError, SolicitudYaDecididaError } = require("../application/SolicitudService");

/**
 * El dueno de la carpeta es quien lleva el token: /citizens/:id/documents solo acepta que :id sea el sub del
 * token. Se comprueba ANTES de leer el archivo, y un intento sobre una carpeta ajena queda en la bitacora (RNF-07).
 */
function requireOwner(auditLogger, action = "documento.cargar") {
  return async function owner(req, res, next) {
    if (req.auth.ciudadanoId === req.params.id) return next();
    try {
      await auditLogger.record({
        actor: req.auth.ciudadanoId,
        actorType: "ciudadano",
        action,
        resource: `carpeta:${req.params.id}`,
        resourceOwner: req.params.id,
        outcome: "rechazo",
        reason: "no_es_dueno",
      });
    } catch (err) {
      logger.error("audit.write_failed", { action, err });
    }
    return res.status(403).json({ error: "solo el dueno de la carpeta puede acceder a sus documentos" });
  };
}

function makeDocumentController(documentService, inboundDocumentService, documentAnalyticsService, solicitudService) {
  return {
    async list(req, res, next) {
      try {
        return res.status(200).json(await documentService.list({ ciudadanoId: req.params.id, page: req.query.page, pageSize: req.query.pageSize }));
      } catch (err) {
        return next(err);
      }
    },
    async upload(req, res, next) {
      try {
        const body = req.body || {};
        const result = await documentService.upload({
          ciudadanoId: req.params.id,
          file: req.file,
          metadata: { titulo: body.titulo, entidadAvaladora: body.entidadAvaladora, fecha: body.fecha, solicitudId: body.solicitudId },
        });
        return res.status(201).json(result);
      } catch (err) {
        return next(err);
      }
    },

    /**
     * HU-10: una entidad emisora entrega un documento en la carpeta de un ciudadano.
     *
     * Quien es la entidad sale de `req.auth` (token institucional ya validado por requireEntityAuth +
     * requireVerifiedEntity), NUNCA del cuerpo. A quien va dirigido sale de la direccion unica del cuerpo, nunca de
     * un ciudadanoId: si llegara uno, se ignora.
     *
     * `201` la primera vez; `200` si es un reintento del mismo envio (idempotencia), para que el cliente distinga
     * sin tener que comparar nada.
     */
    async receive(req, res, next) {
      try {
        const body = req.body || {};
        const result = await inboundDocumentService.receive({
          destinatario: body.destinatario,
          envioId: body.envioId,
          emisor: { id: req.auth.institutionId, verificada: req.auth.verificada },
          file: req.file,
          metadata: { titulo: body.titulo, entidadAvaladora: body.entidadAvaladora, fecha: body.fecha },
        });
        return res.status(result.duplicado ? 200 : 201).json({ documentoId: result.documentoId, duplicado: result.duplicado });
      } catch (err) {
        return next(err);
      }
    },

    /**
     * HU-07.1: metricas agregadas de los documentos que la institucion del token EMITIO. `emisorInstitutionId`
     * sale UNICAMENTE de `req.auth.institutionId` (puesto por requireEntityAuth tras verificar el token): nunca
     * de `req.query`, aunque el cliente mande uno. `from`/`to` son los unicos filtros que se leen del query;
     * cualquier otro parametro (incluido un `institutionId` o `ciudadanoId` que alguien intente mandar) se ignora
     * en silencio, igual que `list()` ignora cualquier query param fuera de `page`/`pageSize`.
     */
    async analyticsSummary(req, res, next) {
      try {
        const result = await documentAnalyticsService.summarize({
          emisorInstitutionId: req.auth.institutionId,
          from: req.query.from,
          to: req.query.to,
        });
        return res.status(200).json(result);
      } catch (err) {
        return next(err);
      }
    },

    /**
     * HU-06.3 (PASO 1): la institucion solicitante sale UNICAMENTE de `req.auth.institutionId` (token ya
     * verificado por requireEntityAuth + requireVerifiedEntity). `ciudadanoId` y `estado` NUNCA se leen del
     * cuerpo: si el cliente los manda, se ignoran (ni siquiera se destructuran aqui). El ciudadano se resuelve
     * dentro del servicio via `direccionUnica`, igual que en HU-10.
     */
    async createSolicitud(req, res, next) {
      try {
        const body = req.body || {};
        const result = await solicitudService.create({
          institutionId: req.auth.institutionId,
          direccionUnica: body.direccionUnica,
          descripcion: body.descripcion,
        });
        return res.status(201).json(result);
      } catch (err) {
        return next(err);
      }
    },

    async listSolicitudes(req, res, next) {
      try {
        const result = await solicitudService.list({ institutionId: req.auth.institutionId, page: req.query.page, pageSize: req.query.pageSize });
        return res.status(200).json(result);
      } catch (err) {
        return next(err);
      }
    },

    async getSolicitud(req, res, next) {
      try {
        const result = await solicitudService.get({ institutionId: req.auth.institutionId, solicitudId: req.params.id });
        return res.status(200).json(result);
      } catch (err) {
        return next(err);
      }
    },

    /**
     * HU-06.3 (PASO 2): el ciudadano sale UNICAMENTE de `req.auth.ciudadanoId` (token de ciudadano ya validado
     * por requireAuth). Nunca de query/body/params -- por eso la ruta es `/citizens/me/...`, no `/citizens/:id/...`.
     */
    async listMyDocumentRequests(req, res, next) {
      try {
        const result = await solicitudService.listForCitizen({ ciudadanoId: req.auth.ciudadanoId, page: req.query.page, pageSize: req.query.pageSize });
        return res.status(200).json(result);
      } catch (err) {
        return next(err);
      }
    },

    /**
     * HU-06.3 (PASO 2): autorizar o rechazar una solicitud propia. `ciudadanoId` sale UNICAMENTE de
     * `req.auth.ciudadanoId`; `decision` es el UNICO campo que se lee del cuerpo (nunca `estado`, `institutionId`
     * ni `ciudadanoId`). No dispara ninguna notificacion ni entrega: solo cambia el estado (ver SolicitudService).
     */
    async decideDocumentRequest(req, res, next) {
      try {
        const body = req.body || {};
        const result = await solicitudService.decide({ ciudadanoId: req.auth.ciudadanoId, solicitudId: req.params.id, decision: body.decision });
        return res.status(200).json(result);
      } catch (err) {
        return next(err);
      }
    },
  };
}

/** Traduce errores conocidos a respuestas HTTP; lo inesperado es un 500 generico (sin detalles internos). */
function errorHandler(err, _req, res, _next) {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof UnsupportedMediaTypeError) return res.status(415).json({ error: err.message });
  if (err instanceof PayloadTooLargeError) return res.status(413).json({ error: err.message });
  if (err instanceof QuotaExceededError) return res.status(409).json({ error: err.message, limite: err.limit });
  // HU-10: la direccion unica no corresponde a nadie de este operador. 404 con el mismo mensaje que una direccion
  // mal formada: no se confirma ni se niega quien esta afiliado aqui.
  if (err instanceof DestinatarioNoEncontradoError) return res.status(404).json({ error: err.message });
  // HU-10: ese envioId ya se uso para otro envio. No se devuelve el documento anterior en silencio.
  if (err instanceof EnvioConflictError) return res.status(409).json({ error: err.message, documentoId: err.documentoId });
  if (err instanceof StorageUnavailableError) return res.status(503).json({ error: err.message });
  // HU-06.3: solicitud inexistente o de otra institucion. Mismo criterio que DestinatarioNoEncontradoError: 404, no 403.
  if (err instanceof SolicitudNotFoundError) return res.status(404).json({ error: err.message });
  // HU-06.3: la solicitud ya tenia una decision. No hay revocacion de consentimiento en esta HU.
  if (err instanceof SolicitudYaDecididaError) return res.status(409).json({ error: err.message });
  // HU-06.3 es la primera ruta de este servicio que recibe JSON (express.json()); las demas reciben multipart.
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "el cuerpo es demasiado grande" });
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) return res.status(400).json({ error: "el cuerpo no es un JSON valido" });
  logger.error("documentos.error_inesperado", { err });
  return res.status(500).json({ error: "Error interno" });
}

module.exports = { makeDocumentController, requireOwner, errorHandler };
