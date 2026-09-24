const logger = require("../tracing/logger");

/**
 * ADR-07: exige que la entidad ya AUTENTICADA este ademas VERIFICADA por el operador.
 *
 * Se monta SIEMPRE despues de `requireEntityAuth`, nunca solo:
 *
 *     requireEntityAuth      -> ¿eres una entidad? (identidad)      401 si no
 *     requireVerifiedEntity  -> ¿eres una entidad CONFIABLE?        403 si no
 *
 * Es el equivalente institucional de `requireOwner` para el ciudadano: el primero dice quien eres, el segundo si
 * puedes tocar ESTE recurso. Por eso la respuesta es **403 y no 401**: la credencial es valida y se reconocio a la
 * entidad; lo que falta es autorizacion, y repetir el login no lo arregla.
 *
 * De donde sale el estado: del claim `ver` del token, que `requireEntityAuth` deja en `req.auth.verificada`. NO se
 * consulta a ms-comparticion (ADR-07): meter una llamada sincrona aqui acoplaria el servicio critico al de
 * comparticion, que es justo lo que la matriz de degradacion de ARQUITECTURA.md evita. El precio, aceptado y
 * documentado: una revocacion tarda hasta lo que viva el token (15 minutos) en surtir efecto en este servicio.
 *
 * Todavia no lo monta ninguna ruta: la primera sera la entrega de documentos de HU-10.
 */
function requireVerifiedEntity(auditLogger, action = "documento.recibir") {
  return async function verified(req, res, next) {
    // Fallo de programacion, no del cliente: la ruta se monto sin requireEntityAuth delante.
    if (!req.auth || !req.auth.institutionId) {
      logger.error("autorizacion.middleware_mal_montado", { action, note: "requireVerifiedEntity exige requireEntityAuth antes" });
      return res.status(403).json({ error: "operacion no permitida" });
    }
    if (req.auth.verificada === true) return next();

    try {
      await auditLogger.record({
        actor: req.auth.institutionId,
        actorType: "entidad",
        action,
        // El recurso es del ciudadano cuando la ruta lo identifica; si no, se deja la propia entidad.
        resource: req.params && req.params.id ? `carpeta:${req.params.id}` : `institucion:${req.auth.institutionId}`,
        resourceOwner: req.params && req.params.id ? req.params.id : req.auth.institutionId,
        outcome: "rechazo",
        reason: "entidad_no_verificada",
      });
    } catch (err) {
      // Un fallo de la bitacora se reporta, pero no convierte un rechazo en un permiso.
      logger.error("audit.write_failed", { action, err });
    }
    return res.status(403).json({ error: "la entidad no esta verificada por el operador" });
  };
}

module.exports = requireVerifiedEntity;
