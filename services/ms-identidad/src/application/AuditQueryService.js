/**
 * Consultas sobre la bitacora para poder demostrar RNF-07 ("0 accesos fuera de politica")
 * de forma auditable y no solo funcional.
 */
class AuditQueryService {
  constructor({ auditRepository }) {
    this.auditRepository = auditRepository;
  }

  /**
   * Un acceso fuera de politica es una operacion EXITOSA sobre un recurso ajeno
   * (actor distinto del dueno) que no fue delegada legitimamente. Los intentos rechazados
   * no son violaciones: son evidencia de que la politica funciona, y se cuentan aparte.
   */
  async verifyNoOutOfPolicyAccess({ from, to } = {}) {
    const entries = await this.auditRepository.findInPeriod({ from, to });

    const violations = entries.filter(
      (e) => e.outcome === "exito" && e.resourceOwner && e.actor !== e.resourceOwner && !e.delegated
    );
    const deniedAttempts = entries.filter((e) => e.outcome === "rechazo").length;

    return {
      compliant: violations.length === 0,
      violations,
      deniedAttempts,
      totalEntries: entries.length,
    };
  }
}

module.exports = AuditQueryService;
