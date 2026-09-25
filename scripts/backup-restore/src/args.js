/**
 * Parser de argumentos minimo, sin dependencias -- mismo estilo que register-operator.js,
 * publish-endpoint.js y verify-institution.js: `--flag` booleano o `--clave=valor`, y deteccion de
 * opciones desconocidas (para responder con codigo 2/uso invalido en vez de ignorarlas en silencio).
 */
function parseArgs(argv, { flags = [], values = [] } = {}) {
  const result = { flags: {}, values: {}, unknown: [] };
  for (const f of flags) result.flags[f] = false;

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      result.unknown.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) {
      const name = arg.slice(2);
      if (flags.includes(name)) {
        result.flags[name] = true;
        continue;
      }
    } else {
      const name = arg.slice(2, eq);
      if (values.includes(name)) {
        result.values[name] = arg.slice(eq + 1);
        continue;
      }
    }
    result.unknown.push(arg);
  }
  return result;
}

module.exports = { parseArgs };
