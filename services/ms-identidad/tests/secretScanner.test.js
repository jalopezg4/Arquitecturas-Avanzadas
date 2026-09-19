const path = require("path");
const { scanText, scanPaths } = require("../scripts/secretScanner");

describe("secretScanner: detecta credenciales hardcodeadas en codigo", () => {
  const cases = [
    ["llave privada", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...", "private-key"],
    ["access key de AWS", 'const k = "AKIAIOSFODNN7EXAMPLE";', "aws-access-key"],
    ["URI de Mongo con contrasena", 'const uri = "mongodb://admin:hunter2pass@db:27017/x";', "uri-with-password"],
    ["URI de RabbitMQ con contrasena", "amqp://user:secretpw@broker:5672", "uri-with-password"],
    ["password literal", 'const password = "hunter2hunter2";', "hardcoded-assignment"],
    ["secreto JWT literal en objeto", "const cfg = { jwtSecret: 'abcd1234efgh5678' };", "hardcoded-assignment"],
    ["api key con guion bajo", 'apiKey = "sk_live_51H8abcdefgh"', "hardcoded-assignment"],
    ["token en yaml", 'token: "ghp_abcdefghijklmnop1234"', "hardcoded-assignment"],
  ];

  test.each(cases)("detecta %s", (_name, text, rule) => {
    const findings = scanText(text, "x.js");
    expect(findings.map((f) => f.rule)).toContain(rule);
  });

  test("el hallazgo indica archivo y linea, pero NUNCA incluye el valor encontrado", () => {
    const [f] = scanText('linea1\nconst password = "hunter2hunter2";', "src/a.js");
    expect(f).toMatchObject({ file: "src/a.js", line: 2, rule: "hardcoded-assignment" });
    expect(JSON.stringify(f)).not.toContain("hunter2");
  });
});

describe("secretScanner: valores SIN comillas en archivos de configuracion", () => {
  const unquoted = [
    [".env", "JWT_SECRET=un-secreto-largo"],
    [".env.production", "DB_PASSWORD=Sup3rSecr3tValue"],
    ["docker-compose.yml", "      password: un-secreto-largo"],
    ["config.yaml", "api_key: sk_live_51H8abcdefgh"],
    ["config.yaml", "  token: ghp_abcdefghijklmnop1234"],
    ["Dockerfile", "ENV JWT_SECRET=un-secreto-largo"],
  ];

  test.each(unquoted)("detecta en %s: %s", (file, line) => {
    expect(scanText(line, file).map((f) => f.rule)).toContain("hardcoded-assignment");
  });

  const legit = [
    [".env.example", "JWT_SECRET=cambiar-en-produccion"], // placeholder documentado; el validador lo rechaza en produccion
    [".env.example", "JWT_SECRET_PREVIOUS="], // vacio
    [".env.example", "TLS_KEY_PATH=/certs/server.key"], // ruta, no secreto
    [".env.example", "PRESIGNED_URL_AUTH_TTL_SECONDS=900"],
    ["docker-compose.yml", "      JWT_SECRET: ${JWT_SECRET:-}"],
    ["ci.yml", "        token: ${{ secrets.GITHUB_TOKEN }}"],
    ["ci.yml", "      - run: npm run scan:secrets"],
    ["config.yaml", "password: <PASSWORD>"],
    ["config.yaml", "password: process.env.DB_PASSWORD"],
  ];

  test.each(legit)("ignora en %s: %s", (file, line) => {
    expect(scanText(line, file)).toEqual([]);
  });

  test("en codigo JS NO trata como credencial una asignacion sin comillas (evita falsos positivos)", () => {
    expect(scanText("const token = getToken(request);", "a.js")).toEqual([]);
    expect(scanText("this.secret = options.secretValue;", "a.js")).toEqual([]);
  });

  test("no duplica el hallazgo cuando ya lo detecta la regla de literales", () => {
    expect(scanText('password: "un-secreto-largo"', "c.yml")).toHaveLength(1);
  });
});

describe("secretScanner: no genera falsos positivos en codigo legitimo", () => {
  const clean = [
    "const secret = process.env.JWT_SECRET;",
    'mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/x");',
    "MONGO_URI: mongodb://mongo:27017/ms-identidad",
    "JWT_SECRET: ${JWT_SECRET:-}",
    "amqp://${RABBIT_USER}:${RABBIT_PASS}@broker:5672",
    'const url = "https://govcarpeta-apis.herokuapp.com/apis/registerCitizen";',
    'passwordHash: { type: String, required: true },',
    'if (password.length < 8) throw new Error("password debe tener al menos 8 caracteres");',
    'const password = "corto";', // menos de 8 caracteres: no es una credencial realista
  ];

  test.each(clean)("ignora: %s", (line) => {
    expect(scanText(line)).toEqual([]);
  });

  test("respeta el marcador secret-scan:allow para constantes de desarrollo documentadas", () => {
    const line = 'const DEV_SECRET = "solo-para-desarrollo-local-1234"; // secret-scan:allow';
    expect(scanText(line)).toEqual([]);
  });
});

describe("secretScanner sobre el repositorio real", () => {
  test("el codigo fuente del servicio no contiene credenciales hardcodeadas", () => {
    const findings = scanPaths([path.resolve(__dirname, "..", "src")]);
    expect(findings).toEqual([]);
  });

  test("detecta un archivo con una credencial (escaneo de directorio de punta a punta)", () => {
    const fs = require("fs");
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
    fs.writeFileSync(path.join(dir, "leak.js"), 'const dbPassword = "Sup3rSecr3tValue";\n');
    fs.writeFileSync(path.join(dir, "ok.js"), "const a = process.env.X;\n");

    const findings = scanPaths([dir]);

    expect(findings).toHaveLength(1);
    expect(path.basename(findings[0].file)).toBe("leak.js");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
