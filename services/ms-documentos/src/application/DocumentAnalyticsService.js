const { ValidationError } = require("./DocumentService");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** `undefined` -> null (parametro ausente, valido). Cualquier otra cosa debe ser una fecha YYYY-MM-DD real. */
function parseDateParam(value, field) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new ValidationError(`${field} debe tener formato YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  // Rechaza fechas que no existen (p. ej. 2026-02-30): Date las "normaliza" corriendolas a otro dia.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${field} no es una fecha valida`);
  }
  return date;
}

/**
 * HU-07.1: metricas agregadas de metadatos, SOLO REST sincrono hacia `ms-documentos` (sin RabbitMQ, sin
 * proyeccion, sin backfill -- decision de alcance para este MVP). El alcance es siempre "documentos que esta
 * institucion EMITIO" (`emisorInstitutionId`), nunca los que un ciudadano cargo por su cuenta (esos no llevan
 * `emisorInstitutionId`) ni los de otra institucion. `emisorInstitutionId` es un parametro de este metodo que el
 * CONTROLADOR debe llenar unicamente con `req.auth.institutionId` (el `sub` del token ya verificado por
 * `requireEntityAuth`) -- este servicio no sabe ni le importa de donde vino, simplemente filtra por el valor que
 * se le da, asi que la garantia de que nunca sea uno arbitrario del cliente es responsabilidad de la ruta.
 */
class DocumentAnalyticsService {
  constructor({ documentRepository }) {
    this.documentRepository = documentRepository;
  }

  async summarize({ emisorInstitutionId, from, to }) {
    const fromDate = parseDateParam(from, "from");
    const toDate = parseDateParam(to, "to");
    if (fromDate && toDate) {
      if (fromDate.getTime() > toDate.getTime()) throw new ValidationError("from no puede ser posterior a to");
      const rangeDays = Math.round((toDate.getTime() - fromDate.getTime()) / ONE_DAY_MS);
      if (rangeDays > MAX_RANGE_DAYS) throw new ValidationError(`el rango entre from y to no puede superar ${MAX_RANGE_DAYS} dias`);
    }
    // `to` se extiende hasta el final de ese dia: si no, un documento fechado justo el dia `to` quedaria excluido
    // (fecha se guarda con hora, y una comparacion a medianoche lo dejaria fuera).
    const toBoundary = toDate ? new Date(toDate.getTime() + ONE_DAY_MS - 1) : null;

    const facets = await this.documentRepository.summarizeByEmisor(emisorInstitutionId, { from: fromDate, to: toBoundary });

    const totalDocumentos = (facets.total[0] && facets.total[0].count) || 0;
    const tamanoTotalBytes = (facets.tamano[0] && facets.tamano[0].total) || 0;
    const tamanoPromedioBytes = facets.tamano[0] && facets.tamano[0].promedio ? Math.round(facets.tamano[0].promedio) : 0;

    return {
      // Se devuelven las fechas TAL COMO SE PIDIERON (no las fronteras internas de la consulta): si no se dio
      // ninguna, el alcance es todo el historico de la institucion -- decision simple para este MVP (ver PASO 1).
      rango: { from: from || null, to: to || null },
      totalDocumentos,
      porEstado: Object.fromEntries(facets.porEstado.map((g) => [g._id, g.count])),
      porMimeType: Object.fromEntries(facets.porMimeType.map((g) => [g._id, g.count])),
      tamanoTotalBytes,
      tamanoPromedioBytes,
      serieTemporal: facets.serieTemporal.map((g) => ({ fecha: g._id, cantidad: g.cantidad })),
    };
  }
}

module.exports = { DocumentAnalyticsService };
