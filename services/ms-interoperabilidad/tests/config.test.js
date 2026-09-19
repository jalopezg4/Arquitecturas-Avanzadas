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
  mongoUri: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "cluster0.mongodb.net/ms-interoperabilidad"),
  govCarpetaBaseUrl: "https://govcarpeta.example.gov.co",
  httpTimeoutMs: 10000,
  operatorId: "6aae9153b7655900026073f1",
  directory: { ttlMinutes: 60, maxStaleMinutes: 1440, minForcedRefreshSeconds: 30, allowPrivateUrls: false, requireHttpsUrls: false },
  ...overrides,
});
const withDirectory = (extra) => prod({ directory: { ...prod().directory, ...extra } });

describe("ConfigValidator de ms-interoperabilidad", () => {
  test("una configuracion de produccion bien formada no tiene problemas", () => {
    expect(validateConfig(prod())).toEqual([]);
  });

  test("fuera de local exige https hacia GovCarpeta y Mongo con TLS sin contrasena debil", () => {
    const problems = validateConfig(prod({ govCarpetaBaseUrl: "http://govcarpeta.co", mongoUri: cred("mongodb", "admin", "admin", "mongo:27017/x") })).join("\n");
    expect(problems).toContain("GOVCARPETA_BASE_URL debe usar https://");
    expect(problems).toContain("MONGO_URI debe usar TLS");
    expect(problems).toContain("contrasena debil");
  });

  test("ALLOW_PRIVATE_OPERATOR_URLS=true se PROHIBE fuera de local (abriria la puerta a SSRF), pero se permite en local", () => {
    expect(validateConfig(withDirectory({ allowPrivateUrls: true })).join()).toContain("ALLOW_PRIVATE_OPERATOR_URLS");
    expect(validateConfig({ ...withDirectory({ allowPrivateUrls: true }), isLocal: true, govCarpetaBaseUrl: "http://localhost:9999", mongoUri: "mongodb://localhost/x" })).toEqual([]);
  });

  test("la vigencia debe estar entre 1 minuto y 1 dia", () => {
    for (const bad of [0, -5, 1441, 1.5, NaN, undefined]) expect(validateConfig(withDirectory({ ttlMinutes: bad })).join()).toContain("OPERATOR_DIRECTORY_TTL_MINUTES");
    expect(validateConfig(withDirectory({ ttlMinutes: 1 }))).toEqual([]);
    expect(validateConfig(withDirectory({ ttlMinutes: 1440, maxStaleMinutes: 1440 }))).toEqual([]);
  });

  test("la antiguedad maxima de la copia no puede ser menor que la vigencia", () => {
    expect(validateConfig(withDirectory({ ttlMinutes: 60, maxStaleMinutes: 30 })).join()).toContain("MAX_STALE_MINUTES no puede ser menor");
    expect(validateConfig(withDirectory({ maxStaleMinutes: 0 })).join()).toContain("OPERATOR_DIRECTORY_MAX_STALE_MINUTES");
  });

  test("el intervalo minimo entre refrescos forzados y el plazo HTTP deben ser positivos", () => {
    expect(validateConfig(withDirectory({ minForcedRefreshSeconds: 0 })).join()).toContain("MIN_FORCED_REFRESH_SECONDS");
    expect(validateConfig(prod({ httpTimeoutMs: 0 })).join()).toContain("GOVCARPETA_TIMEOUT_MS");
  });

  test("OPERATOR_ID, si se define, debe tener formato valido (y puede quedar vacio con un aviso al arrancar)", () => {
    expect(validateConfig(prod({ operatorId: "../x" })).join()).toContain("OPERATOR_ID");
    expect(validateConfig(prod({ operatorId: "" }))).toEqual([]);
  });

  test("informa todos los problemas a la vez", () => {
    const err = (() => {
      try {
        assertValidConfig(prod({ govCarpetaBaseUrl: "http://x", httpTimeoutMs: 0, directory: { ...prod().directory, ttlMinutes: 0, minForcedRefreshSeconds: 0 } }));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe("arranque de ms-interoperabilidad (env.js)", () => {
  const MANAGED = ["NODE_ENV", "MONGO_URI", "GOVCARPETA_BASE_URL", "OPERATOR_ID", "OPERATOR_DIRECTORY_TTL_MINUTES", "OPERATOR_DIRECTORY_MAX_STALE_MINUTES", "MIN_FORCED_REFRESH_SECONDS", "ALLOW_PRIVATE_OPERATOR_URLS", "REQUIRE_HTTPS_OPERATOR_URLS", "GOVCARPETA_TIMEOUT_MS"];
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

  test("en development arranca con la politica por defecto: 60 min de vigencia, 24 h de copia maxima, 30 s entre refrescos forzados", () => {
    const cfg = loadEnvWith({ NODE_ENV: "development" });
    expect(cfg.directory).toEqual({ ttlMinutes: 60, maxStaleMinutes: 1440, minForcedRefreshSeconds: 30, allowPrivateUrls: false, requireHttpsUrls: false });
    expect(cfg.govCarpetaBaseUrl).toBe("https://govcarpeta-apis-4905ff3c005b.herokuapp.com");
  });

  test("la politica se lee de las variables de entorno", () => {
    const cfg = loadEnvWith({ NODE_ENV: "test", OPERATOR_DIRECTORY_TTL_MINUTES: "15", OPERATOR_DIRECTORY_MAX_STALE_MINUTES: "120", MIN_FORCED_REFRESH_SECONDS: "10", REQUIRE_HTTPS_OPERATOR_URLS: "true", OPERATOR_ID: "6aae9153b7655900026073f1" });
    expect(cfg.directory).toMatchObject({ ttlMinutes: 15, maxStaleMinutes: 120, minForcedRefreshSeconds: 10, requireHttpsUrls: true });
    expect(cfg.operatorId).toBe("6aae9153b7655900026073f1");
  });

  test("en produccion con http hacia GovCarpeta, o permitiendo IPs privadas, NO arranca", () => {
    const base = { NODE_ENV: "production", MONGO_URI: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "c.net/x") };
    expect(() => loadEnvWith({ ...base, GOVCARPETA_BASE_URL: "http://govcarpeta.co" })).toThrow(/GOVCARPETA_BASE_URL debe usar https/);
    expect(() => loadEnvWith({ ...base, ALLOW_PRIVATE_OPERATOR_URLS: "true" })).toThrow(/ALLOW_PRIVATE_OPERATOR_URLS/);
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
});
