const fs = require("fs");
const path = require("path");

/**
 * Detecta credenciales hardcodeadas en el codigo y la configuracion (HT-07).
 * Una linea con el marcador `secret-scan:allow` se ignora (para constantes de desarrollo
 * documentadas). Los hallazgos NUNCA incluyen el valor encontrado.
 */
const RULES = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, desc: "llave privada" },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/, desc: "access key de AWS" },
  {
    id: "uri-with-password",
    // scheme://usuario:clave@host, excepto variables (${VAR}, <VAR>) y `process.env`
    re: /[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]+:(?!\$\{|<|process\.env)[^\s@/"'`$]{3,}@/i,
    desc: "URI con contrasena incluida",
  },
  {
    id: "hardcoded-assignment",
    re: /(?:secret|passw(?:or)?d|pwd|api[_-]?key|token|private[_-]?key)\w*["']?\s*[:=]\s*["'`](?!\$\{)[^"'`\s$]{8,}["'`]/i,
    desc: "credencial asignada a un literal",
  },
];

// En archivos de configuracion (.env, yaml) los valores suelen ir SIN comillas: JWT_SECRET=valor,
// password: valor. En codigo JS se mantiene solo el caso entre comillas: sin ellas `token = getToken(req)`
// generaria falsos positivos.
const CONFIG_RULE = {
  id: "hardcoded-assignment",
  re: /(?:secret|passw(?:or)?d|pwd|api[_-]?key|token|private[_-]?key)\w*["']?\s*[:=]\s*["'`]?(?![$<]|process\.env|\{\{)[^\s"'`#]{8,}/i,
  desc: "credencial asignada a un literal (sin comillas)",
};
// Marcadores de "esto no es una credencial real"; el validador de arranque los rechaza en produccion.
const PLACEHOLDER_VALUE = /cambiar-en-produccion|changeme|change-me|your-secret|tu-secreto|example/i;
const CONFIG_EXT = new Set([".env", ".example", ".yml", ".yaml", ".toml"]);

function isConfigFile(file) {
  const base = path.basename(file);
  return CONFIG_EXT.has(path.extname(file)) || base.startsWith(".env") || base === "Dockerfile";
}

const ALLOW_MARKER = "secret-scan:allow";
const SCANNED_EXT = new Set([".js", ".json", ".yml", ".yaml", ".env", ".example", ".sh", ".toml"]);

function scanText(text, file = "<texto>") {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const rule of RULES) {
      if (rule.re.test(line)) findings.push({ file, line: i + 1, rule: rule.id, description: rule.desc });
    }
    if (isConfigFile(file)) {
      const m = CONFIG_RULE.re.exec(line);
      const alreadyFlagged = findings.some((f) => f.file === file && f.line === i + 1);
      if (m && !alreadyFlagged && !PLACEHOLDER_VALUE.test(m[0])) {
        findings.push({ file, line: i + 1, rule: CONFIG_RULE.id, description: CONFIG_RULE.desc });
      }
    }
  });
  return findings;
}

function walk(target, out = []) {
  if (!fs.existsSync(target)) return out;
  const stat = fs.statSync(target);
  if (stat.isFile()) return out.push(target), out;
  for (const name of fs.readdirSync(target)) {
    if (name === "node_modules" || name === ".git") continue;
    walk(path.join(target, name), out);
  }
  return out;
}

function scanPaths(targets) {
  const findings = [];
  for (const file of targets.flatMap((t) => walk(t))) {
    const base = path.basename(file);
    if (!SCANNED_EXT.has(path.extname(file)) && base !== "Dockerfile" && !base.startsWith(".env")) continue;
    findings.push(...scanText(fs.readFileSync(file, "utf8"), file));
  }
  return findings;
}

module.exports = { scanText, scanPaths, RULES, ALLOW_MARKER };
