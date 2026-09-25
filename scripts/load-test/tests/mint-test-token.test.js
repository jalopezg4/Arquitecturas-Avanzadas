const jwt = require("jsonwebtoken");
const { mintToken, keyId, DEV_JWT_SECRET } = require("../mint-test-token");

describe("mintToken()", () => {
  test("produce un token que jwt.verify() acepta con el secreto de desarrollo", () => {
    const token = mintToken();
    const payload = jwt.verify(token, DEV_JWT_SECRET, { algorithms: ["HS256"] });
    expect(payload.sub).toBe("ht03-loadtest-0001");
    expect(payload.iss).toBe("ms-identidad");
    expect(payload.typ).toBe("access");
    expect(payload.jti).toBe("ht03-loadtest");
  });

  test("el header trae el kid que SecretsManager.verify() necesita para encontrar la llave", () => {
    const token = mintToken();
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded.header.alg).toBe("HS256");
    expect(decoded.header.kid).toBe(keyId(DEV_JWT_SECRET));
  });

  test("expira en aproximadamente 2 horas por defecto", () => {
    const token = mintToken();
    const { iat, exp } = jwt.decode(token);
    expect(exp - iat).toBe(2 * 60 * 60);
  });

  test("acepta un sub/issuer/jti/expiresIn distintos", () => {
    const token = mintToken({ sub: "otro-ciudadano", issuer: "otro-emisor", jti: "otro-jti", expiresIn: "10m" });
    const payload = jwt.verify(token, DEV_JWT_SECRET, { algorithms: ["HS256"] });
    expect(payload.sub).toBe("otro-ciudadano");
    expect(payload.iss).toBe("otro-emisor");
    expect(payload.jti).toBe("otro-jti");
  });

  test("keyId() es determinista para el mismo secreto", () => {
    expect(keyId(DEV_JWT_SECRET)).toBe(keyId(DEV_JWT_SECRET));
    expect(keyId(DEV_JWT_SECRET)).toHaveLength(12);
  });
});
