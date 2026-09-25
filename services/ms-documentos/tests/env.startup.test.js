// Prueba el arranque REAL de la configuracion (env.js), no solo el validador aislado.

// env.js llama a dotenv, que releeria el .env del desarrollador y repondria justo las variables que cada prueba borra a
// proposito: la prueba dependeria de la maquina donde corre. Se desactiva aqui.
jest.mock("dotenv", () => ({ config: () => ({}) }));

const cred = (scheme, user, pass, rest) => [scheme, "://", user, ":", pass, "@", rest].join("");
const STRONG = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";

const PROD_ENV = {
  NODE_ENV: "production",
  JWT_SECRET: STRONG,
  RABBITMQ_URI: cred("amqps", "svc", "Zq8mV2nX9pLr", "broker.interno:5671"),
  MONGO_URI: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "cluster0.mongodb.net/ms-documentos"),
  S3_ENDPOINT: "https://s3.archivos.miapp.co",
  S3_ACCESS_KEY_ID: "acceso-prod-7Q2M9XLPRTY41B",
  S3_SECRET_ACCESS_KEY: "w8Zk3Tq0mVx2Lr7Pn5Yc1Hd6Fj4Sg9Ab",
};

const MANAGED = ["NODE_ENV", "JWT_SECRET", "JWT_SECRET_PREVIOUS", "RABBITMQ_URI", "MONGO_URI", "S3_ENDPOINT", "S3_PUBLIC_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE", "QUOTA_NO_CERTIFICADOS", "MAX_UPLOAD_BYTES", "MAX_INBOUND_UPLOAD_BYTES", "PRESIGNED_URL_DOWNLOAD_TTL_SECONDS", "REQUIRE_TLS", "TLS_CERT_PATH", "TLS_KEY_PATH"];

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

describe("arranque de ms-documentos (env.js)", () => {
  test("en produccion con secretos, TLS y storage correctos arranca", () => {
    const cfg = loadEnvWith(PROD_ENV);
    expect(cfg.isLocal).toBe(false);
    expect(cfg.s3.bucket).toBe("carpeta-documentos");
    expect(cfg.limits).toEqual({ quotaNoCertificados: 5, maxUploadBytes: 10 * 1024 * 1024, maxInboundBytes: 50 * 1024 * 1024 });
  });

  test("NODE_ENV ausente o vacio falla cerrado: no se asume development", () => {
    expect(() => loadEnvWith({})).toThrow(/NODE_ENV es obligatorio/);
    expect(() => loadEnvWith({ NODE_ENV: "" })).toThrow(/NODE_ENV es obligatorio/);
  });

  test("en produccion falla sin JWT_SECRET, con el placeholder, o sin credenciales de storage", () => {
    const { JWT_SECRET, ...noSecret } = PROD_ENV;
    expect(() => loadEnvWith(noSecret)).toThrow(/JWT_SECRET/);
    expect(() => loadEnvWith({ ...PROD_ENV, JWT_SECRET: "cambiar-en-produccion" })).toThrow(/placeholder/);
    const { S3_ACCESS_KEY_ID, ...noKeys } = PROD_ENV;
    expect(() => loadEnvWith(noKeys)).toThrow(/S3_ACCESS_KEY_ID es obligatorio/);
  });

  test("en produccion NO cae a las credenciales de MinIO ni al endpoint local", () => {
    const { S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, ...base } = PROD_ENV;
    expect(() => loadEnvWith(base)).toThrow(/S3_ENDPOINT debe usar https/);
  });

  test("un NODE_ENV distinto de development/test (staging) tambien es estricto", () => {
    expect(() => loadEnvWith({ ...PROD_ENV, NODE_ENV: "staging", MONGO_URI: "mongodb://mongo:27017/x" })).toThrow(/MONGO_URI/);
  });

  test("en development arranca con los defaults de desarrollo (MinIO local, cuota 5, 10 MB, 1 hora)", () => {
    const cfg = loadEnvWith({ NODE_ENV: "development" });
    expect(cfg.isLocal).toBe(true);
    expect(cfg.s3.endpoint).toBe("http://localhost:9000");
    expect(cfg.limits.quotaNoCertificados).toBe(5);
    expect(cfg.presignedDownloadTtlSeconds).toBe(3600);
    expect(cfg.jwtIssuer).toBe("ms-identidad");
  });

  test("la cuota, el tamano y el bucket se leen de las variables de entorno", () => {
    const cfg = loadEnvWith({ NODE_ENV: "test", QUOTA_NO_CERTIFICADOS: "3", MAX_UPLOAD_BYTES: "2048", S3_BUCKET: "otro-bucket" });
    expect(cfg.limits).toEqual({ quotaNoCertificados: 3, maxUploadBytes: 2048, maxInboundBytes: 50 * 1024 * 1024 });
    expect(cfg.s3.bucket).toBe("otro-bucket");
  });

  test("HU-10: el limite de la recepcion institucional se lee del entorno y tiene sus propias reglas", () => {
    const cfg = loadEnvWith({ NODE_ENV: "test", MAX_INBOUND_UPLOAD_BYTES: "20971520" });
    expect(cfg.limits.maxInboundBytes).toBe(20971520);

    // No puede superar el tope duro (el archivo se procesa en memoria) ni quedar por debajo del limite del ciudadano.
    expect(() => loadEnvWith({ NODE_ENV: "test", MAX_INBOUND_UPLOAD_BYTES: String(60 * 1024 * 1024) })).toThrow(/MAX_INBOUND_UPLOAD_BYTES/);
    expect(() => loadEnvWith({ NODE_ENV: "test", MAX_UPLOAD_BYTES: "10485760", MAX_INBOUND_UPLOAD_BYTES: "1024" })).toThrow(/MAX_INBOUND_UPLOAD_BYTES/);
    expect(() => loadEnvWith({ NODE_ENV: "test", MAX_INBOUND_UPLOAD_BYTES: "0" })).toThrow(/MAX_INBOUND_UPLOAD_BYTES/);
  });

  test("una vigencia de URL prefirmada fuera de politica (> 1 hora) impide arrancar", () => {
    expect(() => loadEnvWith({ NODE_ENV: "development", PRESIGNED_URL_DOWNLOAD_TTL_SECONDS: "7200" })).toThrow(/no puede superar 3600s/);
  });
});

describe("plazos del cliente S3 (por defecto deben caber antes del gateway)", () => {
  test("los defaults arrancan y 2 intentos quedan por debajo del plazo del gateway (10 s)", () => {
    const cfg = loadEnvWith({ NODE_ENV: "development" });
    expect(2 * (cfg.s3.connectTimeoutMs + cfg.s3.requestTimeoutMs)).toBeLessThan(10000);
  });
});
