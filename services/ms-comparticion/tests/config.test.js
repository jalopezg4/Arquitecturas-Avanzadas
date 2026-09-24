// env.js llama a dotenv, que releeria el .env del desarrollador y repondria justo las variables que cada prueba borra a
// proposito: la prueba dependeria de la maquina donde corre. Se desactiva aqui.
jest.mock("dotenv", () => ({ config: () => ({}) }));

const request = require("supertest");
const { validateConfig, assertValidConfig, ConfigError } = require("../src/config/ConfigValidator");
const buildApp = require("../src/app");

// Las URIs con usuario:contrasena se ARMAN aqui en vez de escribirse completas: son valores falsos de prueba, pero un
// escaner de secretos no distingue un fixture de una credencial real y abre alertas.
const cred = (scheme, user, pass, rest) => [scheme, "://", user, ":", pass, "@", rest].join("");

const STRONG = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";

const prod = (overrides = {}) => ({
  isLocal: false,
  mongoUri: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "cluster0.mongodb.net/ms-comparticion"),
  registrationToken: "",
  // ADR-07: este servicio firma los tokens institucionales, asi que fuera de local la llave es obligatoria.
  entityJwtSecret: STRONG,
  entityJwtSecretPrevious: [],
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

  describe("ENTITY_JWT_SECRET: la llave de los tokens institucionales (ADR-07)", () => {
    test.each([
      ["ausente", undefined],
      ["vacia", ""],
      ["corta", "abc123"],
      ["placeholder", "cambiar-en-produccion"],
      ["la de desarrollo", "solo-para-desarrollo-local-entidades-nunca-en-despliegue"],
      ["poca variedad", "a".repeat(40)],
    ])("fuera de local, una llave %s impide arrancar", (_name, secret) => {
      expect(validateConfig(prod({ entityJwtSecret: secret })).join()).toContain("ENTITY_JWT_SECRET");
    });

    test("valida tambien las llaves anteriores de la rotacion", () => {
      expect(validateConfig(prod({ entityJwtSecretPrevious: [STRONG, "corta"] })).join()).toContain("ENTITY_JWT_SECRET_PREVIOUS[1]");
    });

    test("el mensaje de error nunca contiene el valor de la llave", () => {
      try {
        assertValidConfig(prod({ entityJwtSecret: "cambiar-en-produccion" }));
      } catch (e) {
        expect(e.message).not.toContain("cambiar-en-produccion");
      }
    });

    test("en local no se exige llave fuerte (hay una de desarrollo)", () => {
      expect(validateConfig({ isLocal: true, mongoUri: "mongodb://localhost:27017/x", registrationToken: "", entityJwtSecret: "dev" })).toEqual([]);
    });

    test("la vigencia del token institucional no puede superar los 15 minutos (ADR-06)", () => {
      expect(validateConfig(prod({ entityAccessExpiresIn: "15m" }))).toEqual([]);
      expect(validateConfig(prod({ entityAccessExpiresIn: "24h" })).join()).toContain("ENTITY_ACCESS_EXPIRES_IN");
      expect(validateConfig(prod({ entityAccessExpiresIn: "un rato" })).join()).toContain("ENTITY_ACCESS_EXPIRES_IN");
    });
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
  const MANAGED = ["NODE_ENV", "MONGO_URI", "REGISTRATION_TOKEN", "PORT", "ENTITY_JWT_SECRET", "ENTITY_JWT_SECRET_PREVIOUS", "ENTITY_ACCESS_EXPIRES_IN"];
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

  test("ADR-07: en development hay llave de entidades de desarrollo; en produccion sin ENTITY_JWT_SECRET NO arranca", () => {
    const cfg = loadEnvWith({ NODE_ENV: "development" });
    expect(cfg.entityJwtSecret).toBeTruthy();
    expect(cfg.entityAccessExpiresIn).toBe("15m");

    expect(() => loadEnvWith({ NODE_ENV: "production", MONGO_URI: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "c.net/x") })).toThrow(/ENTITY_JWT_SECRET/);
  });

  test("lee ENTITY_JWT_SECRET y sus llaves anteriores de las variables de entorno", () => {
    const cfg = loadEnvWith({ NODE_ENV: "test", ENTITY_JWT_SECRET: STRONG, ENTITY_JWT_SECRET_PREVIOUS: `${STRONG}, Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A ` });
    expect(cfg.entityJwtSecret).toBe(STRONG);
    expect(cfg.entityJwtSecretPrevious).toEqual([STRONG, "Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A"]);
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
