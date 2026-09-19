// Prueba el arranque REAL de la configuracion (env.js), no solo el validador aislado.
const STRONG = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";

const PROD_ENV = {
  NODE_ENV: "production",
  JWT_SECRET: STRONG,
  GOVCARPETA_BASE_URL: "https://govcarpeta.example.gov.co",
  RABBITMQ_URI: "amqps://svc:Zq8mV2nX9pLr@broker.internal:5671",
  MONGO_URI: "mongodb+srv://svc:Zq8mV2nX9pLr@cluster0.mongodb.net/ms-identidad",
};

function loadEnvWith(vars) {
  const saved = { ...process.env };
  for (const k of ["NODE_ENV", "JWT_SECRET", "JWT_SECRET_PREVIOUS", "GOVCARPETA_BASE_URL", "RABBITMQ_URI", "MONGO_URI", "REQUIRE_TLS", "TLS_CERT_PATH", "TLS_KEY_PATH", "PRESIGNED_URL_AUTH_TTL_SECONDS"]) {
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
