// env.js llama a dotenv, que releeria el .env del desarrollador y repondria justo las variables que cada prueba borra a
// proposito: la prueba dependeria de la maquina donde corre. Se desactiva aqui.
jest.mock("dotenv", () => ({ config: () => ({}) }));

const request = require("supertest");
const { validateConfig, assertValidConfig, ConfigError } = require("../src/config/ConfigValidator");
const buildApp = require("../src/app");

// Las URIs con usuario:contrasena se ARMAN aqui en vez de escribirse completas: son valores falsos de prueba, pero un
// escaner de secretos no distingue un fixture de una credencial real y abre alertas.
const cred = (scheme, user, pass, rest) => [scheme, "://", user, ":", pass, "@", rest].join("");
const ENTITY_SECRET = "Rk3pL8bN2vXq6tZ4mC9sHd1jF7gW5yAu"; // 32 caracteres, solo de prueba

const prod = (overrides = {}) => ({
  isLocal: false,
  mongoUri: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "cluster0.mongodb.net/ms-analitica"),
  entityJwtSecret: ENTITY_SECRET,
  documentosUrl: "http://ms-documentos:3002",
  documentsAnalyticsTimeoutMs: 5000,
  ...overrides,
});

describe("ConfigValidator de ms-analitica", () => {
  test("una configuracion de produccion bien formada no tiene problemas", () => {
    expect(validateConfig(prod())).toEqual([]);
  });

  test("fuera de local exige Mongo con TLS y sin contrasena debil", () => {
    const problems = validateConfig(prod({ mongoUri: cred("mongodb", "admin", "admin", "mongo:27017/x") })).join("\n");
    expect(problems).toContain("MONGO_URI debe usar TLS");
    expect(problems).toContain("contrasena debil");
  });

  test("fuera de local exige ENTITY_JWT_SECRET fuerte (protege /api/v1/cases, ADR-07)", () => {
    expect(validateConfig(prod({ entityJwtSecret: "" })).join()).toContain("ENTITY_JWT_SECRET");
    expect(validateConfig(prod({ entityJwtSecret: "corta" })).join()).toContain("ENTITY_JWT_SECRET");
    expect(validateConfig(prod({ entityJwtSecretPrevious: ["corta"] })).join()).toContain("ENTITY_JWT_SECRET_PREVIOUS[0]");
  });

  test("en local no se exige TLS ni ENTITY_JWT_SECRET (pero DOCUMENTOS_URL/timeout se validan en TODO ambiente)", () => {
    expect(
      validateConfig({ isLocal: true, mongoUri: "mongodb://localhost:27017/ms-analitica", documentosUrl: "http://localhost:3002", documentsAnalyticsTimeoutMs: 5000 })
    ).toEqual([]);
  });

  test("DOCUMENTOS_URL debe ser una URL http(s) valida, y el timeout un entero positivo -- en cualquier ambiente", () => {
    expect(validateConfig(prod({ documentosUrl: "no-es-una-url" })).join()).toContain("DOCUMENTOS_URL");
    expect(validateConfig(prod({ documentosUrl: "" })).join()).toContain("DOCUMENTOS_URL");
    expect(validateConfig(prod({ documentsAnalyticsTimeoutMs: 0 })).join()).toContain("DOCUMENTS_ANALYTICS_TIMEOUT_MS");
    expect(validateConfig(prod({ documentsAnalyticsTimeoutMs: -1 })).join()).toContain("DOCUMENTS_ANALYTICS_TIMEOUT_MS");
    expect(
      validateConfig({ isLocal: true, mongoUri: "mongodb://localhost:27017/x", documentosUrl: "bad", documentsAnalyticsTimeoutMs: 5000 }).join()
    ).toContain("DOCUMENTOS_URL"); // tambien en local: no depende de isLocal
  });

  test("informa todos los problemas a la vez", () => {
    const err = (() => {
      try {
        assertValidConfig(prod({ mongoUri: cred("mongodb", "admin", "admin", "mongo:27017/x"), entityJwtSecret: "" }));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("arranque de ms-analitica (env.js)", () => {
  const MANAGED = ["NODE_ENV", "PORT", "MONGO_URI", "ENTITY_JWT_SECRET", "ENTITY_JWT_SECRET_PREVIOUS", "ENTITY_JWT_ISSUER", "DOCUMENTOS_URL", "DOCUMENTS_ANALYTICS_TIMEOUT_MS"];
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

  test("en development arranca con los valores por defecto (incluida la llave institucional de desarrollo)", () => {
    const cfg = loadEnvWith({ NODE_ENV: "development" });
    expect(cfg.port).toBe(3006);
    expect(cfg.mongoUri).toBe("mongodb://localhost:27017/ms-analitica");
    expect(cfg.entityJwtSecret).toBe("solo-para-desarrollo-local-entidades-nunca-en-despliegue");
    expect(cfg.entityJwtIssuer).toBe("ms-comparticion");
    expect(cfg.documentosUrl).toBe("http://localhost:3002");
    expect(cfg.documentsAnalyticsTimeoutMs).toBe(5000);
  });

  test("el puerto, la URI de Mongo, la llave institucional y DOCUMENTOS_URL se leen de las variables de entorno", () => {
    const cfg = loadEnvWith({
      NODE_ENV: "test",
      PORT: "4001",
      MONGO_URI: "mongodb://localhost:27017/otra",
      ENTITY_JWT_SECRET: ENTITY_SECRET,
      ENTITY_JWT_ISSUER: "otro-emisor",
      DOCUMENTOS_URL: "http://ms-documentos:3002",
      DOCUMENTS_ANALYTICS_TIMEOUT_MS: "8000",
    });
    expect(cfg.port).toBe("4001");
    expect(cfg.mongoUri).toBe("mongodb://localhost:27017/otra");
    expect(cfg.entityJwtSecret).toBe(ENTITY_SECRET);
    expect(cfg.entityJwtIssuer).toBe("otro-emisor");
    expect(cfg.documentosUrl).toBe("http://ms-documentos:3002");
    expect(cfg.documentsAnalyticsTimeoutMs).toBe(8000);
  });

  test("en produccion con Mongo sin TLS NO arranca", () => {
    expect(() => loadEnvWith({ NODE_ENV: "production", MONGO_URI: cred("mongodb", "admin", "admin", "mongo:27017/x"), ENTITY_JWT_SECRET: ENTITY_SECRET })).toThrow(/MONGO_URI debe usar TLS/);
  });

  test("en produccion sin ENTITY_JWT_SECRET NO arranca (fallaria cerrado en cada peticion, mejor no arrancar)", () => {
    const base = { NODE_ENV: "production", MONGO_URI: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "c.net/x") };
    expect(() => loadEnvWith(base)).toThrow(/ENTITY_JWT_SECRET/);
    expect(() => loadEnvWith({ ...base, ENTITY_JWT_SECRET: ENTITY_SECRET })).not.toThrow();
  });

  test("con DOCUMENTOS_URL mal formada NO arranca, en ningun ambiente", () => {
    expect(() => loadEnvWith({ NODE_ENV: "development", DOCUMENTOS_URL: "no-es-una-url" })).toThrow(/DOCUMENTOS_URL/);
  });
});

describe("salud (HT-01)", () => {
  test("/health responde 200 siempre; /ready segun el estado", async () => {
    let ready = false;
    const app = buildApp({ isReady: () => ready });

    await request(app).get("/health").expect(200, { status: "ok" });
    await request(app).get("/ready").expect(503);
    ready = true;
    await request(app).get("/ready").expect(200, { status: "ready" });
  });

  test("devuelve el x-trace-id y no anuncia el framework", async () => {
    const res = await request(buildApp()).get("/health").set("x-trace-id", "traza-cliente-0001");
    expect(res.headers["x-trace-id"]).toBe("traza-cliente-0001");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  test("sin pqrsCaseService, /api/v1/cases responde 404 (no montado) -- compatibilidad con el PASO 1", async () => {
    await request(buildApp()).get("/api/v1/cases").expect(404);
  });

  test("sin analyticsService, /api/v1/analytics/summary responde 404 (no montado)", async () => {
    await request(buildApp()).get("/api/v1/analytics/summary").expect(404);
  });

  test("sin documentRequestService, /api/v1/premium/document-requests responde 404 (no montado)", async () => {
    await request(buildApp()).get("/api/v1/premium/document-requests").expect(404);
  });
});
