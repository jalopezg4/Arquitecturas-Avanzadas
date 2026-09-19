#!/usr/bin/env node
// Uso: docker compose logs --no-color | node scripts/trace.js <trace-id>
// Imprime en orden cronologico todo lo que paso con esa peticion, en todos los servicios.
const LogAggregator = require("../src/tracing/LogAggregator");

const traceId = process.argv[2];
if (!traceId) {
  console.error("Uso: node scripts/trace.js <trace-id>  (logs por stdin)");
  process.exit(2);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const aggregator = LogAggregator.fromText(input);
  const lines = aggregator.timeline(traceId);
  if (lines.length === 0) {
    console.error(`No hay logs con trace-id ${traceId}`);
    process.exit(1);
  }
  console.log(lines.join("\n"));
  const failure = aggregator.firstError(traceId);
  if (failure) console.log(`\nPrimer error: ${failure.msg} (servicio ${failure.service})`);
});
