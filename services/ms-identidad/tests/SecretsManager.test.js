const jwt = require("jsonwebtoken");
const SecretsManager = require("../src/security/SecretsManager");

const KEY_A = "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe";
const KEY_B = "Qw3rT7yU1oP5aS9dF2gH6jK8lZ4xC0vB";
const KEY_C = "Mn5bV8cX1zL4kJ7hG0fD3sA6pO9iU2yT";

describe("SecretsManager", () => {
  test("firma con la llave activa y verifica el token", () => {
    const sm = new SecretsManager({ active: KEY_A });
    const token = sm.sign({ sub: "123" }, { expiresIn: "15m" });

    expect(sm.verify(token)).toMatchObject({ sub: "123" });
  });

  test("rota credenciales sin causar caida: los tokens emitidos antes de rotar siguen siendo validos", () => {
    const sm = new SecretsManager({ active: KEY_A });
    const beforeRotation = sm.sign({ sub: "ana" }, { expiresIn: "15m" });

    sm.rotate(KEY_B);

    expect(sm.verify(beforeRotation)).toMatchObject({ sub: "ana" }); // la sesion no se pierde
    const afterRotation = sm.sign({ sub: "luis" }, { expiresIn: "15m" });
    expect(sm.verify(afterRotation)).toMatchObject({ sub: "luis" });
  });

  test("tras rotar, los tokens nuevos se firman con la llave nueva", () => {
    const sm = new SecretsManager({ active: KEY_A });
    sm.rotate(KEY_B);
    const token = sm.sign({ sub: "x" });

    expect(sm.status().activeKid).toBe(jwt.decode(token, { complete: true }).header.kid);
    expect(() => jwt.verify(token, KEY_B)).not.toThrow(); // firmado con B
    expect(() => jwt.verify(token, KEY_A)).toThrow(); // no con A
  });

  test("al retirar las llaves anteriores, los tokens viejos dejan de ser validos", () => {
    const sm = new SecretsManager({ active: KEY_A });
    const old = sm.sign({ sub: "ana" });
    sm.rotate(KEY_B);

    expect(sm.retirePrevious()).toBe(1);

    expect(() => sm.verify(old)).toThrow(/retirada|desconocida/);
    expect(() => sm.verify(sm.sign({ sub: "nuevo" }))).not.toThrow();
  });

  test("soporta rotaciones encadenadas: A -> B -> C mientras A y B siguen verificando", () => {
    const sm = new SecretsManager({ active: KEY_A });
    const tokenA = sm.sign({ sub: "a" });
    sm.rotate(KEY_B);
    const tokenB = sm.sign({ sub: "b" });
    sm.rotate(KEY_C);

    expect(sm.verify(tokenA).sub).toBe("a");
    expect(sm.verify(tokenB).sub).toBe("b");
    expect(sm.status().previousKids).toHaveLength(2);
  });

  test("arranca con llaves anteriores desde la configuracion (despliegue posterior a una rotacion)", () => {
    const oldManager = new SecretsManager({ active: KEY_A });
    const token = oldManager.sign({ sub: "ana" });

    const redeployed = new SecretsManager({ active: KEY_B, previous: [KEY_A] });

    expect(redeployed.verify(token).sub).toBe("ana");
  });

  test("rechaza rotar a una llave debil, placeholder o repetida", () => {
    const sm = new SecretsManager({ active: KEY_A });

    expect(() => sm.rotate("corta")).toThrow(/menos de 32/);
    expect(() => sm.rotate("cambiar-en-produccion-cambiar-en-produccion")).toThrow(/placeholder/);
    expect(() => sm.rotate(KEY_A)).toThrow(/distinta/);
    expect(sm.status().previousKids).toHaveLength(0); // un intento fallido no altera el llavero
  });

  test("rechaza tokens manipulados, expirados, sin kid o con algoritmo none", () => {
    const sm = new SecretsManager({ active: KEY_A });
    const token = sm.sign({ sub: "ana" }, { expiresIn: "15m" });
    const [h, p, s] = token.split(".");

    expect(() => sm.verify(`${h}.${Buffer.from('{"sub":"admin"}').toString("base64url")}.${s}`)).toThrow();
    expect(() => sm.verify(sm.sign({ sub: "x" }, { expiresIn: -10 }))).toThrow(/expired/);
    expect(() => sm.verify(jwt.sign({ sub: "x" }, KEY_A))).toThrow(/desconocida/); // sin kid
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: sm.status().activeKid })).toString("base64url")}.${p}.`;
    expect(() => sm.verify(none)).toThrow();
  });

  test("un token firmado con otra llave desconocida es rechazado", () => {
    const attacker = new SecretsManager({ active: KEY_C });
    const sm = new SecretsManager({ active: KEY_A });

    expect(() => sm.verify(attacker.sign({ sub: "admin" }))).toThrow(/desconocida/);
  });

  test("status expone ids de llave, nunca el secreto", () => {
    const sm = new SecretsManager({ active: KEY_A, previous: [KEY_B] });
    const status = JSON.stringify(sm.status());

    expect(status).not.toContain(KEY_A);
    expect(status).not.toContain(KEY_B);
  });

  test("exige una llave activa", () => {
    expect(() => new SecretsManager({})).toThrow(/llave activa/);
  });
});
