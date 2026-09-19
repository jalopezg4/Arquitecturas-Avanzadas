const fs = require("fs");

/**
 * Crea o actualiza `KEY=value` en un archivo .env conservando el resto de lineas y su fin de linea.
 * Es como el operatorId "se persiste en configuracion": el .env esta en .gitignore. En ambientes
 * desplegados el valor va como variable de entorno / secreto de la plataforma, no en un archivo.
 */
function upsertEnvVar(filePath, key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`upsertEnvVar: nombre de variable invalido: ${key}`);
  if (/[\r\n]/.test(String(value))) throw new Error("upsertEnvVar: el valor no puede contener saltos de linea");

  const exists = fs.existsSync(filePath);
  const original = exists ? fs.readFileSync(filePath, "utf8") : "";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original === "" ? [] : original.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const line = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);

  fs.writeFileSync(filePath, lines.join(eol) + eol, "utf8");
  return { created: !exists, replaced: idx >= 0 };
}

module.exports = { upsertEnvVar };
