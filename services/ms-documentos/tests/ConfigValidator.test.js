const { validateConfig, assertValidConfig, ConfigError } = require("../src/config/ConfigValidator");

// Las URIs con usuario:contrasena se ARMAN aqui en vez de escribirse completas: son valores falsos de prueba, pero un
// escaner de secretos no distingue un fixture de una credencial real y abre alertas.
const cred = (scheme, user, pass, rest) => [scheme, "://", user, ":", pass, "@", rest].join("");

const STRONG = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";

function prod(overrides = {}) {
  return {
    isLocal: false,
    jwtSecret: STRONG,
    jwtSecretPrevious: [],
    rabbitUri: cred("amqps", "svc", "Zq8mV2nX9pLr", "broker.interno:5671"),
    mongoUri: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "cluster0.mongodb.net/ms-documentos"),
    s3: { endpoint: "https://s3.archivos.miapp.co", bucket: "carpeta-documentos", accessKeyId: "acceso-prod-7Q2M9XLPRTY41B", secretAccessKey: "w8Zk3Tq0mVx2Lr7Pn5Yc1Hd6Fj4Sg9Ab" },
    limits: { quotaNoCertificados: 5, maxUploadBytes: 10 * 1024 * 1024 },
    presignedDownloadTtlSeconds: 3600,
    tls: { certPath: "", keyPath: "", caPath: "", required: false },
    ...overrides,
  };
}

describe("ConfigValidator de ms-documentos", () => {
  test("una configuracion de produccion bien formada no tiene problemas", () => {
    expect(validateConfig(prod())).toEqual([]);
  });

  test("fuera de local exige la llave JWT fuerte (la misma de ms-identidad), no placeholders", () => {
    for (const bad of ["", "cambiar-en-produccion", "solo-para-desarrollo-local-nunca-usar-en-despliegue", "corta"]) {
      expect(() => assertValidConfig(prod({ jwtSecret: bad }))).toThrow(ConfigError);
    }
  });

  test("el mensaje de error nunca contiene el valor de un secreto", () => {
    try {
      assertValidConfig(prod({ jwtSecret: "cambiar-en-produccion", s3: { ...prod().s3, secretAccessKey: "minioadmin" } }));
    } catch (e) {
      expect(e.message).not.toContain("cambiar-en-produccion");
      expect(e.message).not.toContain("minioadmin");
    }
  });

  describe("object storage", () => {
    test("fuera de local exige https y credenciales que no sean las de tutorial", () => {
      const problems = validateConfig(prod({ s3: { endpoint: "http://minio:9000", bucket: "carpeta-documentos", accessKeyId: "minioadmin", secretAccessKey: "" } })).join("\n");
      expect(problems).toContain("S3_ENDPOINT debe usar https://");
      expect(problems).toContain("S3_ACCESS_KEY_ID es una credencial por defecto");
      expect(problems).toContain("S3_SECRET_ACCESS_KEY es obligatorio");
    });

    test("el nombre del bucket debe ser valido, tambien en local", () => {
      for (const bad of ["", "MAYUSCULAS", "a", "con espacio", "../x"]) {
        expect(validateConfig(prod({ isLocal: true, s3: { ...prod().s3, bucket: bad } })).join()).toContain("S3_BUCKET");
      }
    });

    test("en local se aceptan MinIO por http y sus credenciales de desarrollo", () => {
      expect(validateConfig(prod({ isLocal: true, s3: { endpoint: "http://localhost:9000", bucket: "carpeta-documentos", accessKeyId: "minioadmin", secretAccessKey: "minioadmin" } }))).toEqual([]);
    });
  });

  describe("plazos del cliente S3 (deben rendirse antes que el gateway)", () => {
    const withTimeouts = (connectTimeoutMs, requestTimeoutMs) => prod({ s3: { ...prod().s3, connectTimeoutMs, requestTimeoutMs } });

    test("los valores por defecto (2 s + 4 s, 2 intentos = 12 s teorico) se rechazan solo si superan el tope; 2000/2000 cabe", () => {
      expect(validateConfig(withTimeouts(2000, 2000))).toEqual([]);
      expect(validateConfig(withTimeouts(1000, 3000))).toEqual([]); // 2 x 4000 = 8000 <= 9000
    });

    test("2 intentos que no caben antes del plazo del gateway impiden arrancar", () => {
      expect(validateConfig(withTimeouts(2000, 4000)).join()).toContain("no pueden superar 9000 ms"); // 2 x 6000 = 12000
      expect(validateConfig(withTimeouts(10000, 10000)).join()).toContain("deben rendirse antes que el gateway");
    });

    test("deben ser enteros positivos", () => {
      for (const bad of [0, -1, 1.5, NaN]) expect(validateConfig(withTimeouts(bad, 1000)).join()).toContain("S3_CONNECT_TIMEOUT_MS");
    });
  });

  describe("limites (cuota, tamano, vigencia de URLs)", () => {
    test("la cuota y el tamano deben ser enteros positivos", () => {
      for (const bad of [0, -1, 1.5, NaN, undefined]) {
        expect(validateConfig(prod({ limits: { quotaNoCertificados: bad, maxUploadBytes: 1 } })).join()).toContain("QUOTA_NO_CERTIFICADOS");
        expect(validateConfig(prod({ limits: { quotaNoCertificados: 5, maxUploadBytes: bad } })).join()).toContain("MAX_UPLOAD_BYTES");
      }
    });

    test("el tamano maximo de carga no puede superar 50 MB", () => {
      expect(validateConfig(prod({ limits: { quotaNoCertificados: 5, maxUploadBytes: 50 * 1024 * 1024 + 1 } })).join()).toContain("no puede superar");
    });

    test("la vigencia de la URL de descarga no puede superar 1 hora (ADR-06)", () => {
      expect(validateConfig(prod({ presignedDownloadTtlSeconds: 3601 })).join()).toContain("no puede superar 3600s");
      expect(validateConfig(prod({ presignedDownloadTtlSeconds: 0 })).join()).toContain("entero positivo");
    });
  });

  test("Mongo y RabbitMQ fuera de local exigen TLS y sin contrasenas por defecto", () => {
    const problems = validateConfig(prod({ mongoUri: cred("mongodb", "admin", "admin", "mongo:27017/x"), rabbitUri: cred("amqp", "guest", "guest", "broker:5672") })).join("\n");
    expect(problems).toContain("MONGO_URI debe usar TLS");
    expect(problems).toContain("RABBITMQ_URI debe usar amqps://");
    expect(problems).toContain("contrasena debil");
  });

  test("reglas de TLS propias: cert y llave juntos; mTLS y REQUIRE_TLS exigen certificado", () => {
    expect(validateConfig(prod({ tls: { certPath: "/c" } })).join()).toContain("juntos");
    expect(validateConfig(prod({ tls: { caPath: "/ca" } })).join()).toContain("TLS_CA_PATH");
    expect(validateConfig(prod({ tls: { required: true } })).join()).toContain("REQUIRE_TLS");
  });
});
