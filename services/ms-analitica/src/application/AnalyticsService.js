class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * HU-07.1: orquesta la llamada a `ms-documentos` (Alternativa A aprobada -- REST sincrono, `ms-documentos`
 * agrega, `ms-analitica` solo reenvia). NO reimplementa las reglas de negocio de fechas (formato real de
 * calendario, rango invertido, maximo de dias): eso sigue siendo responsabilidad EXCLUSIVA de `ms-documentos`,
 * para no duplicar logica entre servicios. Aqui solo se descarta lo obviamente invalido (formato basico), para
 * no gastar una llamada de red en algo que ya se sabe que va a fallar.
 */
class AnalyticsService {
  constructor({ documentsAnalyticsClient }) {
    this.documentsAnalyticsClient = documentsAnalyticsClient;
  }

  /** `authorization` es el header CRUDO recibido por este servicio; se reenvia tal cual, nunca se transforma. */
  async summarize({ authorization, from, to }) {
    if (from !== undefined && !DATE_RE.test(from)) throw new ValidationError("from debe tener formato YYYY-MM-DD");
    if (to !== undefined && !DATE_RE.test(to)) throw new ValidationError("to debe tener formato YYYY-MM-DD");

    return this.documentsAnalyticsClient.getSummary({ authorization, from, to });
  }
}

module.exports = { AnalyticsService, ValidationError };
