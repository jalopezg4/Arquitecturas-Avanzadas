const request = require("supertest");
const { validateConfig, MAX_AUTH_TTL_SECONDS } = require("../src/config/ConfigValidator");
const buildApp = require("../src/app");

/** Configuracion local valida (la misma forma que arma env.js). */
function localConfig(overrides = {}) {
  return {
    isLocal: true,
    mongoUri: "mongodb://localhost:27017/ms-autenticacion",
    rabbitUri: "amqp://localhost:5672",
    s3: { endpoint: "http://localhost:9000", bucket: "carpeta-documentos", accessKeyId: "minioadmin", secretAccessKey: "minioadmin", connectTimeoutMs: 1500, requestTimeoutMs: 2500 },
    presignedAuthTtlSeconds: 900,
    govCarpeta: { baseUrl: "https://govcarpeta.test", timeoutMs: 10000, maxAttempts: 3, baseDelayMs: 1000 },
    eventPublishTimeoutMs: 3000,
    ...overrides,
  };
}

/** Configuracion de despliegue valida. */
function prodConfig(overrides = {}) {
  return localConfig({
    isLocal: false,
    mongoUri: "mongodb+srv://svc:Xk29vLq8Pw@cluster.example.net/ms-autenticacion",
    rabbitUri: "amqps://svc:Xk29vLq8Pw@broker.example.net",
    s3: { endpoint: "https://s3.example.net", publicEndpoint: "https://files.example.net", bucket: "carpeta-documentos", accessKeyId: "AKIAREALKEY", secretAccessKey: "s3cr3t-real-value", connectTimeoutMs: 1500, requestTimeoutMs: 2500 },
    ...overrides,
  });
}

describe("ConfigValidator de ms-autenticacion", () => {
  test("una configuracion local valida no tiene problemas", () => {
    expect(validateConfig(localConfig())).toEqual([]);
  });

  test("una configuracion de despliegue valida no tiene problemas", () => {
    expect(validateConfig(prodConfig())).toEqual([]);
  });

  test("la vigencia de la URL para GovCarpeta no puede superar 15 minutos (ADR-06), en ningun ambiente", () => {
    expect(MAX_AUTH_TTL_SECONDS).toBe(900);
    expect(validateConfig(localConfig({ presignedAuthTtlSeconds: 901 })).join()).toMatch(/PRESIGNED_URL_AUTH_TTL_SECONDS/);
    expect(validateConfig(localConfig({ presignedAuthTtlSeconds: 0 })).join()).toMatch(/PRESIGNED_URL_AUTH_TTL_SECONDS/);
  });

  test("no se permiten mas de 3 intentos contra GovCarpeta (HU-04)", () => {
    const gc = { baseUrl: "https://govcarpeta.test", timeoutMs: 10000, maxAttempts: 4, baseDelayMs: 1000 };
    expect(validateConfig(localConfig({ govCarpeta: gc })).join()).toMatch(/GOVCARPETA_MAX_ATTEMPTS/);
  });

  test("fuera de local exige TLS en broker, base, storage, host publico y GovCarpeta, y rechaza credenciales de tutorial", () => {
    const problems = validateConfig(
      prodConfig({
        mongoUri: "mongodb://localhost:27017/x",
        rabbitUri: "amqp://localhost",
        s3: { endpoint: "http://minio:9000", publicEndpoint: "http://files.local", bucket: "carpeta-documentos", accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
        govCarpeta: { baseUrl: "http://govcarpeta.test", timeoutMs: 10000, maxAttempts: 3, baseDelayMs: 1000 },
      })
    ).join("\n");

    for (const esperado of ["RABBITMQ_URI", "MONGO_URI", "S3_ENDPOINT", "S3_PUBLIC_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "GOVCARPETA_BASE_URL"]) {
      expect(problems).toContain(esperado);
    }
    // Nunca imprime el valor de un secreto.
    expect(problems).not.toContain("minioadmin");
  });
});

describe("env.js", () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
    jest.resetModules();
  });

  test("sin NODE_ENV el servicio no arranca (falla cerrado)", () => {
    process.env = { ...original };
    delete process.env.NODE_ENV;
    expect(() => require("../src/config/env")).toThrow(/NODE_ENV es obligatorio/);
  });

  test("en test arma una configuracion valida con 15 minutos y 3 intentos por defecto", () => {
    process.env = { ...original, NODE_ENV: "test" };
    const env = require("../src/config/env");
    expect(env).toMatchObject({ port: 3007, presignedAuthTtlSeconds: 900, govCarpeta: { maxAttempts: 3 } });
  });
});

describe("/health y /ready (HT-01)", () => {
  test("/health responde 200; /ready 503 mientras no esta listo y 200 cuando si", async () => {
    let listo = false;
    const app = buildApp({ isReady: () => listo });

    await request(app).get("/health").expect(200);
    await request(app).get("/ready").expect(503);
    listo = true;
    await request(app).get("/ready").expect(200);
  });
});
