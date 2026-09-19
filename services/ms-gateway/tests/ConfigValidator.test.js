const { validateConfig, assertValidConfig, ConfigError } = require("../src/config/ConfigValidator");

const STRONG = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";

const prod = (overrides = {}) => ({
  isLocal: false,
  jwtSecret: STRONG,
  jwtSecretPrevious: [],
  upstreams: { IDENTIDAD_URL: "http://ms-identidad:3001" },
  tls: { certPath: "", keyPath: "", caPath: "", required: false },
  ...overrides,
});

describe("ConfigValidator del gateway", () => {
  test("una configuracion bien formada no tiene problemas", () => {
    expect(validateConfig(prod())).toEqual([]);
  });

  test("fuera de local exige una llave JWT fuerte (la misma de ms-identidad), no placeholders", () => {
    for (const bad of ["", "cambiar-en-produccion", "solo-para-desarrollo-local-nunca-usar-en-despliegue", "corta"]) {
      expect(() => assertValidConfig(prod({ jwtSecret: bad }))).toThrow(ConfigError);
    }
  });

  test("valida tambien las llaves anteriores de la rotacion", () => {
    expect(validateConfig(prod({ jwtSecretPrevious: [STRONG, "corta"] })).join()).toContain("JWT_SECRET_PREVIOUS[1]");
  });

  test("el mensaje de error nunca contiene el valor del secreto", () => {
    try {
      assertValidConfig(prod({ jwtSecret: "cambiar-en-produccion" }));
    } catch (e) {
      expect(e.message).not.toContain("cambiar-en-produccion");
    }
  });

  test("en local no exige llave fuerte", () => {
    expect(validateConfig(prod({ isLocal: true, jwtSecret: "dev" }))).toEqual([]);
  });

  test("las URLs de los servicios destino deben ser http(s) validas, tambien en local", () => {
    for (const bad of ["", "ms-identidad:3001", "ftp://x", "no es url"]) {
      expect(validateConfig(prod({ isLocal: true, upstreams: { IDENTIDAD_URL: bad } })).join()).toContain("IDENTIDAD_URL");
    }
  });

  test("reglas de TLS: cert y llave juntos; mTLS y REQUIRE_TLS exigen certificado", () => {
    expect(validateConfig(prod({ tls: { certPath: "/c" } })).join()).toContain("juntos");
    expect(validateConfig(prod({ tls: { caPath: "/ca" } })).join()).toContain("TLS_CA_PATH");
    expect(validateConfig(prod({ tls: { required: true } })).join()).toContain("REQUIRE_TLS");
  });
});
