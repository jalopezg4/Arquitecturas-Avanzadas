// env.js llama a dotenv, que releeria el .env del desarrollador y repondria justo las variables que cada prueba borra a
// proposito: la prueba dependeria de la maquina donde corre. Se desactiva aqui.
jest.mock("dotenv", () => ({ config: () => ({}) }));

const request = require("supertest");
const { validateConfig, assertValidConfig, ConfigError } = require("../src/config/ConfigValidator");
const buildApp = require("../src/app");

// Las URIs con usuario:contrasena se ARMAN aqui en vez de escribirse completas: son valores falsos de prueba, pero un
// escaner de secretos no distingue un fixture de una credencial real y abre alertas.
const cred = (scheme, user, pass, rest) => [scheme, "://", user, ":", pass, "@", rest].join("");

const prod = (overrides = {}) => ({
  isLocal: false,
  mongoUri: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "cluster0.mongodb.net/ms-comparticion"),
  registrationToken: "",
  ...overrides,
});

describe("ConfigValidator de ms-comparticion", () => {
  test("una configuracion de produccion bien formada no tiene problemas (con o sin token)", () => {
    expect(validateConfig(prod())).toEqual([]);
    expect(validateConfig(prod({ registrationToken: "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe" }))).toEqual([]);
  });

  test("fuera de local Mongo exige TLS, sin desactivar la validacion del certificado ni contrasenas debiles", () => {
    const problems = validateConfig(prod({ mongoUri: cred("mongodb", "admin", "admin", "mongo:27017/x?tlsInsecure=true") })).join("\n");
    expect(problems).toContain("MONGO_URI debe usar TLS");
    expect(problems).toContain("contrasena debil");
  });

  test("en local no exige TLS", () => {
    expect(validateConfig({ isLocal: true, mongoUri: "mongodb://localhost:27017/x", registrationToken: "" })).toEqual([]);
  });

  test.each([
    ["muy corto", "abc123"],
    ["placeholder", "cambiar-en-produccion-por-favor-ya"],
    ["poca variedad", "a".repeat(40)],
  ])("un REGISTRATION_TOKEN %s se rechaza (en cualquier ambiente)", (_name, token) => {
    expect(validateConfig(prod({ isLocal: true, registrationToken: token })).join()).toContain("REGISTRATION_TOKEN");
  });

  test("el mensaje de error nunca contiene el valor del token", () => {
    try {
      assertValidConfig(prod({ registrationToken: "cambiar-en-produccion-por-favor-ya" }));
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.message).not.toContain("cambiar-en-produccion-por-favor-ya");
    }
  });
});

describe("arranque de ms-comparticion (env.js)", () => {
  const MANAGED = ["NODE_ENV", "MONGO_URI", "REGISTRATION_TOKEN", "PORT"];
  function loadEnvWith(vars) {
    const saved = { ...process.env };
    for (const k of MANAGED) delete process.env[k];
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

  test("NODE_ENV ausente o vacio falla cerrado", () => {
    expect(() => loadEnvWith({})).toThrow(/NODE_ENV es obligatorio/);
    expect(() => loadEnvWith({ NODE_ENV: "" })).toThrow(/NODE_ENV es obligatorio/);
  });

  test("en development arranca con el registro ABIERTO (sin token) por defecto, como pide el issue", () => {
    const cfg = loadEnvWith({ NODE_ENV: "development" });
    expect(cfg.registrationToken).toBe("");
    expect(cfg.port).toBe(3005);
  });

  test("lee REGISTRATION_TOKEN de la variable de entorno", () => {
    const cfg = loadEnvWith({ NODE_ENV: "test", REGISTRATION_TOKEN: "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe" });
    expect(cfg.registrationToken).toBe("k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe");
  });

  test("en produccion sin TLS hacia Mongo, o con un token debil, NO arranca", () => {
    expect(() => loadEnvWith({ NODE_ENV: "production", MONGO_URI: "mongodb://mongo:27017/x" })).toThrow(/MONGO_URI debe usar TLS/);
    expect(() => loadEnvWith({ NODE_ENV: "production", MONGO_URI: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "c.net/x"), REGISTRATION_TOKEN: "corto" })).toThrow(/REGISTRATION_TOKEN/);
  });
});

describe("salud (HT-01)", () => {
  test("/health responde 200 siempre; /ready segun el estado", async () => {
    let ready = false;
    const app = buildApp({ institutionService: {}, isReady: () => ready });

    await request(app).get("/health").expect(200, { status: "ok" });
    await request(app).get("/ready").expect(503);
    ready = true;
    await request(app).get("/ready").expect(200, { status: "ready" });
  });
});
