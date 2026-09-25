#!/usr/bin/env node
// Uso: npm run scan:secrets   -- falla (exit 1) si hay credenciales hardcodeadas. Corre en CI.
const path = require("path");
const { scanPaths } = require("./secretScanner");

const root = path.resolve(__dirname, "..");
const repoRoot = path.resolve(root, "..", "..");

// Solo codigo y configuracion desplegable. Los tests usan datos falsos a proposito.
const targets = [
  path.join(root, "src"),
  path.join(root, "Dockerfile"),
  path.join(root, ".env.example"),
  path.join(repoRoot, "docker-compose.yml"),
  path.join(repoRoot, ".github"),
];

const findings = scanPaths(targets);
if (findings.length === 0) {
  console.log("scan-secrets: sin credenciales hardcodeadas");
  process.exit(0);
}
console.error("scan-secrets: posibles credenciales hardcodeadas (el valor no se muestra):");
for (const f of findings) console.error(`  ${path.relative(repoRoot, f.file)}:${f.line}  ${f.description} [${f.rule}]`);
console.error("Mover el valor a una variable de entorno / GitHub Secret, o marcar la linea con `secret-scan:allow` si es un valor de desarrollo documentado.");
process.exit(1);
