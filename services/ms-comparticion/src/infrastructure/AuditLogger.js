const { OUTCOMES, ACTOR_TYPES } = require("../domain/AuditEntry");
const { getTraceId } = require("../tracing/TraceContext");

/**
 * Registra en la bitacora quien hizo que, cuando y con que resultado (HT-04, RF-39, RNF-07).
 * Recibe el repositorio por constructor para poder probarse sin base de datos.
 */
class AuditLogger {
  constructor({ auditRepository }) {
    this.auditRepository = auditRepository;
  }

  async record({
    actor,
    actorType = "ciudadano",
    action,
    resource,
    resourceOwner,
    delegated = false,
    outcome,
    reason,
    metadata,
  }) {
    if (typeof actor !== "string" || !actor.trim()) {
      throw new Error("AuditLogger: actor es requerido");
    }
    if (typeof action !== "string" || !action.trim()) {
      throw new Error("AuditLogger: action es requerida");
    }
    if (!OUTCOMES.includes(outcome)) {
      throw new Error(`AuditLogger: outcome debe ser uno de ${OUTCOMES.join(", ")}`);
    }
    if (!ACTOR_TYPES.includes(actorType)) {
      throw new Error(`AuditLogger: actorType debe ser uno de ${ACTOR_TYPES.join(", ")}`);
    }

    return this.auditRepository.create({
      actor,
      actorType,
      action,
      resource,
      resourceOwner,
      delegated,
      outcome,
      reason,
      metadata,
      traceId: getTraceId(),
      timestamp: new Date(),
    });
  }
}

module.exports = AuditLogger;
