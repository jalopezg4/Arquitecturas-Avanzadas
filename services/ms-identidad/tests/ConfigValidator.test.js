const { validateConfig, assertValidConfig, ConfigError, isStrongSecret, parseDuration } = require("../src/config/ConfigValidator");

const STRONG = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe"; // 32 caracteres, variados

function prodConfig(overrides = {}) {
  return {
    isLocal: false,
    jwtSecret: STRONG,
    jwtSecretPrevious: [],
    govCarpetaBaseUrl: "https://govcarpeta.example.gov.co",
    rabbitUri: "amqps://svc:Zq8mV2nX9pLr@broker.internal:5671",
    mongoUri: "mongodb+srv://svc:Zq8mV2nX9pLr@cluster0.mongodb.net/ms-identidad",
    tls: { certPath: "", keyPath: "", caPath: "", required: false },
    presignedUrl: { authTtlSeconds: 900, downloadTtlSeconds: 3600 },
    ...overrides,
  };
}

describe("ConfigValidator", () => {
  test("una configuracion de produccion bien formada no tiene problemas", () => {
    expect(validateConfig(prodConfig())).toEqual([]);
  });

  test("falla el arranque si el secreto es un placeholder o valor por defecto hardcodeado", () => {
    for (const bad of ["cambiar-en-produccion", "solo-para-desarrollo-local-nunca-usar-en-despliegue", "changeme".repeat(6)]) {
      expect(() => assertValidConfig(prodConfig({ jwtSecret: bad }))).toThrow(ConfigError);
    }
  });

  test("falla si el secreto esta ausente, es corto o casi no tiene variedad", () => {
    expect(validateConfig(prodConfig({ jwtSecret: "" })).join()).toContain("JWT_SECRET");
    expect(validateConfig(prodConfig({ jwtSecret: "abc123" })).join()).toContain("menos de 32");
    expect(validateConfig(prodConfig({ jwtSecret: "a".repeat(40) })).join()).toContain("variedad");
  });

  test("valida tambien las llaves anteriores de la rotacion", () => {
    const problems = validateConfig(prodConfig({ jwtSecretPrevious: [STRONG, "corta"] }));
    expect(problems.join()).toContain("JWT_SECRET_PREVIOUS[1]");
  });

  test("el mensaje de error nunca contiene el valor del secreto", () => {
    const leaky = "cambiar-en-produccion";
    try {
      assertValidConfig(prodConfig({ jwtSecret: leaky }));
    } catch (e) {
      expect(e.message).not.toContain(leaky);
    }
  });

  test("en local (development/test) no exige secretos fuertes ni TLS", () => {
    const local = prodConfig({
      isLocal: true,
      jwtSecret: "dev",
      govCarpetaBaseUrl: "http://localhost:9999",
      rabbitUri: "amqp://localhost:5672",
      mongoUri: "mongodb://localhost:27017/x",
    });
    expect(validateConfig(local)).toEqual([]);
  });

  describe("trafico cifrado fuera de local", () => {
    test("rechaza GovCarpeta, RabbitMQ y Mongo sin TLS", () => {
      const problems = validateConfig(
        prodConfig({
          govCarpetaBaseUrl: "http://govcarpeta.example",
          rabbitUri: "amqp://svc:Zq8mV2nX9pLr@broker:5672",
          mongoUri: "mongodb://svc:Zq8mV2nX9pLr@mongo:27017/x",
        })
      );
      expect(problems.join("\n")).toContain("GOVCARPETA_BASE_URL debe usar https");
      expect(problems.join("\n")).toContain("RABBITMQ_URI debe usar amqps");
      expect(problems.join("\n")).toContain("MONGO_URI debe usar TLS");
    });

    test("rechaza Mongo con TLS desactivado explicitamente, incluso con mongodb+srv://", () => {
      for (const flag of ["tls=false", "ssl=false", "retryWrites=true&tls=false", "TLS=FALSE"]) {
        const problems = validateConfig(prodConfig({ mongoUri: `mongodb+srv://svc:Zq8mV2nX9pLr@c.mongodb.net/x?${flag}` }));
        expect(problems.join()).toContain("desactiva TLS");
      }
    });

    test("rechaza Mongo que desactiva la validacion del certificado (tlsInsecure, tlsAllowInvalid*, sslValidate=false)", () => {
      for (const flag of ["tlsInsecure=true", "tlsAllowInvalidCertificates=true", "tlsAllowInvalidHostnames=true", "sslValidate=false"]) {
        const problems = validateConfig(prodConfig({ mongoUri: `mongodb+srv://svc:Zq8mV2nX9pLr@c.mongodb.net/x?${flag}` }));
        expect(problems.join()).toContain("validacion del certificado");
      }
    });

    test("no da falsos positivos con parametros legitimos de Mongo", () => {
      const ok = "mongodb+srv://svc:Zq8mV2nX9pLr@c.mongodb.net/x?retryWrites=true&w=majority&tlsInsecure=false";
      expect(validateConfig(prodConfig({ mongoUri: ok }))).toEqual([]);
    });

    test("acepta Mongo con ?tls=true", () => {
      expect(validateConfig(prodConfig({ mongoUri: "mongodb://svc:Zq8mV2nX9pLr@mongo:27017/x?tls=true" }))).toEqual([]);
    });

    test("rechaza contrasenas debiles o por defecto en las URIs", () => {
      const problems = validateConfig(
        prodConfig({ rabbitUri: "amqps://guest:guest@broker:5671", mongoUri: "mongodb+srv://admin:admin@c.mongodb.net/x" })
      );
      expect(problems.filter((p) => p.includes("contrasena debil"))).toHaveLength(2);
    });
  });

  describe("configuracion TLS del propio servicio", () => {
    test("certificado y llave deben ir juntos", () => {
      expect(validateConfig(prodConfig({ tls: { certPath: "/c.pem", keyPath: "" } })).join()).toContain("juntos");
    });

    test("mTLS (CA) requiere certificado y llave; REQUIRE_TLS exige configurarlo", () => {
      expect(validateConfig(prodConfig({ tls: { caPath: "/ca.pem" } })).join()).toContain("TLS_CA_PATH");
      expect(validateConfig(prodConfig({ tls: { required: true } })).join()).toContain("REQUIRE_TLS");
      expect(validateConfig(prodConfig({ tls: { certPath: "/c", keyPath: "/k", caPath: "/ca", required: true } }))).toEqual([]);
    });
  });

  describe("politica de expiracion de URLs prefirmadas (ADR-06)", () => {
    test("la vigencia de autenticacion no puede superar 15 minutos", () => {
      const problems = validateConfig(prodConfig({ presignedUrl: { authTtlSeconds: 901, downloadTtlSeconds: 3600 } }));
      expect(problems.join()).toContain("no puede superar 900s");
    });

    test("la vigencia de descarga no puede superar 1 hora", () => {
      const problems = validateConfig(prodConfig({ presignedUrl: { authTtlSeconds: 900, downloadTtlSeconds: 7200 } }));
      expect(problems.join()).toContain("no puede superar 3600s");
    });

    test("rechaza valores no positivos o no enteros, tambien en local", () => {
      const local = { isLocal: true, presignedUrl: { authTtlSeconds: 0, downloadTtlSeconds: NaN } };
      expect(validateConfig(local)).toHaveLength(2);
    });
  });

  describe("vigencia de tokens de sesion (HU-02)", () => {
    test("parseDuration entiende s/m/h/d y rechaza basura", () => {
      expect(parseDuration("15m")).toBe(900);
      expect(parseDuration("900s")).toBe(900);
      expect(parseDuration("1h")).toBe(3600);
      expect(parseDuration("7d")).toBe(604800);
      expect(parseDuration(900)).toBe(900);
      for (const bad of ["", "15", "0m", "-5m", "abc", "1.5h", null, undefined, 0, 1.5]) expect(parseDuration(bad)).toBeNull();
    });

    test("15m/7d (los valores por defecto) son validos", () => {
      expect(validateConfig(prodConfig({ jwtAccessExpiresIn: "15m", jwtRefreshExpiresIn: "7d" }))).toEqual([]);
    });

    test("el access token no puede vivir mas de 15 minutos (no 24h)", () => {
      for (const bad of ["16m", "1h", "24h"]) {
        expect(validateConfig(prodConfig({ jwtAccessExpiresIn: bad, jwtRefreshExpiresIn: "7d" })).join()).toContain("no puede superar 900s");
      }
    });

    test("el refresh token debe vivir mas que el access token", () => {
      expect(validateConfig(prodConfig({ jwtAccessExpiresIn: "15m", jwtRefreshExpiresIn: "10m" })).join()).toContain("mayor que JWT_ACCESS_EXPIRES_IN");
    });

    test("rechaza duraciones ilegibles, tambien en local", () => {
      const problems = validateConfig(prodConfig({ isLocal: true, jwtAccessExpiresIn: "rapido", jwtRefreshExpiresIn: "" }));
      expect(problems).toHaveLength(2);
    });
  });

  test("informa todos los problemas a la vez, no solo el primero", () => {
    const problems = validateConfig(prodConfig({ jwtSecret: "x", govCarpetaBaseUrl: "http://x", tls: { certPath: "/c" } }));
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  test("isStrongSecret distingue llaves aleatorias de placeholders", () => {
    expect(isStrongSecret(STRONG)).toBe(true);
    expect(isStrongSecret("cambiar-en-produccion")).toBe(false);
  });
});
