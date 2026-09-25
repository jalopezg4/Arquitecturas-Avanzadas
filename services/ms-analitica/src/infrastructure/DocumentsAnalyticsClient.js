const axios = require("axios");
const logger = require("../tracing/logger");
const { getTraceId, TRACE_ID_HEADER } = require("../tracing/TraceContext");

/** `ms-documentos` rechazo `from`/`to` (formato, rango invertido, mas de 366 dias, etc.). */
class UpstreamValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamValidationError";
  }
}
/** `ms-documentos` no respondio a tiempo, no esta disponible, o respondio algo inesperado (nunca se detalla al cliente). */
class UpstreamUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamUnavailableError";
  }
}

/**
 * Cliente HTTP hacia el endpoint interno de analitica de `ms-documentos` (HU-07.1, Alternativa A: REST sincrono
 * -- sin RabbitMQ, sin proyeccion, sin backfill en este MVP). REENVIA tal cual el `Authorization` que este
 * servicio ya recibio y verifico con su propio `requireEntityAuth`: nunca genera ni transforma un token.
 * `ms-documentos` vuelve a verificarlo de forma independiente (ADR-07, defensa en profundidad) y deriva la
 * institucion de su propio `sub`, asi que la autorizacion no depende de nada que este cliente decida.
 *
 * Sin reintentos, a proposito: a diferencia de `GovCarpetaDirectoryClient` (una API externa, flakey, donde
 * reintentar tiene sentido), esta es una llamada interna en la misma red; un timeout aqui es mas probable una
 * caida real que una falla transitoria, y reintentar solo amplificaria carga durante un incidente.
 */
class DocumentsAnalyticsClient {
  constructor({ baseUrl, timeoutMs, http }) {
    this.baseUrl = baseUrl;
    this.http = http || axios.create({ timeout: timeoutMs });
  }

  _traceHeaders() {
    const traceId = getTraceId();
    return traceId ? { [TRACE_ID_HEADER]: traceId } : {};
  }

  /**
   * `authorization` es el header CRUDO tal como llego a ms-analitica (p. ej. "Bearer eyJ..."), nunca decodificado
   * ni reconstruido. `from`/`to` se reenvian tal cual (o se omiten si no vinieron): las reglas de fechas
   * (formato, rango invertido, maximo de dias) son responsabilidad exclusiva de ms-documentos, no se duplican aqui.
   */
  async getSummary({ authorization, from, to }) {
    const params = {};
    if (from !== undefined) params.from = from;
    if (to !== undefined) params.to = to;

    let res;
    try {
      res = await this.http.get(`${this.baseUrl}/api/v1/documents/analytics/summary`, {
        params,
        headers: { Authorization: authorization, ...this._traceHeaders() },
      });
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 400) {
        const message = (err.response.data && err.response.data.error) || "parametros invalidos";
        throw new UpstreamValidationError(message);
      }
      logger.error("analitica.ms_documentos_no_disponible", { err, status });
      throw new UpstreamUnavailableError("el servicio de analitica de documentos no esta disponible");
    }
    return res.data;
  }
}

module.exports = { DocumentsAnalyticsClient, UpstreamValidationError, UpstreamUnavailableError };
