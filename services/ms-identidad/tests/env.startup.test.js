// Prueba el arranque REAL de la configuracion (env.js), no solo el validador aislado.

// env.js llama a dotenv, que releeria el .env del desarrollador y repondria justo las variables que cada prueba
// borra a proposito (NODE_ENV, JWT_SECRET...): la prueba dependeria de la maquina donde corre. Se desactiva aqui.
jest.mock("dotenv", () => ({ config: () => ({}) }));

// Las URIs con usuario:contrasena se ARMAN aqui en vez de escribirse completas: son valores falsos de prueba, pero un
// escaner de secretos (p. ej. el de GitHub) no distingue un fixture de una credencial real y abre alertas.
const cred = (scheme, user, pass, rest) => [scheme, "://", user, ":", pass, "@", rest].join("");

const STRONG = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";

const PROD_ENV = {
  NODE_ENV: "production",
  JWT_SECRET: STRONG,
  GOVCARPETA_BASE_URL: "https://govcarpeta.example.gov.co",
  RABBITMQ_URI: cred("amqps", "svc", "Zq8mV2nX9pLr", "broker.internal:5671"),
  MONGO_URI: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "cluster0.mongodb.net/ms-identidad"),
};

function loadEnvWith(vars) {
  const saved = { ...process.env };
  for (const k of ["NODE_ENV", "JWT_SECRET", "JWT_SECRET_PREVIOUS", "GOVCARPETA_BASE_URL", "RABBITMQ_URI", "MONGO_URI", "REQUIRE_TLS", "TLS_CERT_PATH", "TLS_KEY_PATH", "PRESIGNED_URL_AUTH_TTL_SECONDS", "OPERATOR_NAME", "OPERATOR_ID"]) {
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    let cfg;
    jest.isolateModules(() => {
      cfg = require("../src/config/env");
    });
    return cfg;
  } finally {
    process.env = saved;
  }
}

describe("arranque (env.js)", () => {
  // registerCitizen envia este nombre a GovCarpeta: si no coincide con el registrado, el sandbox puede rechazar los registros.
  test("sin OPERATOR_NAME usa el nombre registrado en GovCarpeta (MiFolio) y sin OPERATOR_ID queda vacio", () => {
    const cfg = loadEnvWith({ NODE_ENV: "development" });
    expect(cfg.operatorName).toBe("MiFolio");
    expect(cfg.operatorId).toBe("");
  });

  test("OPERATOR_NAME y OPERATOR_ID explicitos tienen prioridad sobre los valores por defecto", () => {
    const cfg = loadEnvWith({ NODE_ENV: "development", OPERATOR_NAME: "Otro Operador", OPERATOR_ID: "6aae9153b7655900026073f1" });
    expect(cfg.operatorName).toBe("Otro Operador");
    expect(cfg.operatorId).toBe("6aae9153b7655900026073f1");
  });

  test("en produccion con secretos y TLS correctos arranca", () => {
    const cfg = loadEnvWith(PROD_ENV);
    expect(cfg.isLocal).toBe(false);
    expect(cfg.jwtSecret).toBe(STRONG);
  });

  test("falla el arranque en produccion si falta JWT_SECRET", () => {
    const { JWT_SECRET, ...withoutSecret } = PROD_ENV;
    expect(() => loadEnvWith(withoutSecret)).toThrow(/JWT_SECRET/);
  });

  test("falla el arranque en produccion con el placeholder de .env.example", () => {
    expect(() => loadEnvWith({ ...PROD_ENV, JWT_SECRET: "cambiar-en-produccion" })).toThrow(/placeholder/);
  });

  test("falla el arranque en produccion con las URLs por defecto (sin TLS)", () => {
    expect(() => loadEnvWith({ NODE_ENV: "production", JWT_SECRET: STRONG })).toThrow(/amqps|TLS/);
  });

  test("un NODE_ENV distinto de development/test (ej. staging) tambien es estricto", () => {
    expect(() => loadEnvWith({ ...PROD_ENV, NODE_ENV: "staging", JWT_SECRET: "corta" })).toThrow(/JWT_SECRET/);
  });

  test("NODE_ENV ausente falla cerrado: no se asume development ni se usa una llave conocida", () => {
    expect(() => loadEnvWith({})).toThrow(/NODE_ENV es obligatorio/);
    expect(() => loadEnvWith({ JWT_SECRET: STRONG })).toThrow(/NODE_ENV es obligatorio/); // ni con secreto valido
  });

  test("NODE_ENV vacio tambien falla cerrado", () => {
    expect(() => loadEnvWith({ NODE_ENV: "" })).toThrow(/NODE_ENV es obligatorio/);
  });

  test("en development arranca con defaults de desarrollo", () => {
    const cfg = loadEnvWith({ NODE_ENV: "development" });
    expect(cfg.isLocal).toBe(true);
    expect(cfg.jwtSecret).toBeTruthy();
  });

  test("lee las llaves anteriores de la rotacion como lista", () => {
    const other = "Qw3rT7yU1oP5aS9dF2gH6jK8lZ4xC0vB";
    const cfg = loadEnvWith({ ...PROD_ENV, JWT_SECRET_PREVIOUS: ` ${other} ,` });
    expect(cfg.jwtSecretPrevious).toEqual([other]);
  });

  test("REQUIRE_TLS=true sin certificado impide arrancar", () => {
    expect(() => loadEnvWith({ ...PROD_ENV, REQUIRE_TLS: "true" })).toThrow(/REQUIRE_TLS/);
  });

  test("una vigencia de URL prefirmada fuera de politica impide arrancar", () => {
    expect(() => loadEnvWith({ NODE_ENV: "development", PRESIGNED_URL_AUTH_TTL_SECONDS: "3600" })).toThrow(/900s/);
  });
});
