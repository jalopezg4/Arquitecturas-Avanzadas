/**
 * Reconstruye el recorrido de una peticion a partir de lineas de log estructuradas (JSON).
 * Sirve con logs de uno o varios servicios mezclados (ej. `docker compose logs`), porque solo
 * mira el trace-id. No es un agregador centralizado (ELK/Loki): trabaja sobre el texto que se le da.
 */
class LogAggregator {
  constructor(entries) {
    this.entries = entries;
  }

  /** Acepta texto con lineas mezcladas: ignora lo que no sea JSON y tolera prefijos de docker compose. */
  static fromText(text) {
    const entries = [];
    for (const line of String(text).split(/\r?\n/)) {
      const start = line.indexOf("{");
      if (start === -1) continue;
      try {
        const entry = JSON.parse(line.slice(start));
        if (entry && typeof entry === "object" && entry.traceId) entries.push(entry);
      } catch {
        // linea que no es JSON valido: se ignora
      }
    }
    return new LogAggregator(entries);
  }

  byTraceId(traceId) {
    return this.entries
      .filter((e) => e.traceId === traceId)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }

  services(traceId) {
    return [...new Set(this.byTraceId(traceId).map((e) => e.service))];
  }

  /** Primera linea de error del recorrido: indica en que paso fallo. */
  firstError(traceId) {
    return this.byTraceId(traceId).find((e) => e.level === "error");
  }

  timeline(traceId) {
    return this.byTraceId(traceId).map((e) => {
      const { ts, level, service, msg, traceId: _t, ...rest } = e;
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
      return `${ts} [${service}] ${level.toUpperCase()} ${msg}${extra}`;
    });
  }
}

module.exports = LogAggregator;
