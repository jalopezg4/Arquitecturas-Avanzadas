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

  describe("despliegue GRADUAL con varias replicas (rotacion en dos fases)", () => {
    test("rotar en UN solo paso rompe sesiones: una replica vieja no puede verificar lo que firma la nueva", () => {
      const oldReplica = new SecretsManager({ active: KEY_A });
      const newReplica = new SecretsManager({ active: KEY_B, previous: [KEY_A] });

      // la replica nueva acepta lo viejo...
      expect(newReplica.verify(oldReplica.sign({ sub: "ana" })).sub).toBe("ana");
      // ...pero la vieja NO acepta lo nuevo: el usuario cuyo request cae en ella pierde la sesion
      expect(() => oldReplica.verify(newReplica.sign({ sub: "luis" }))).toThrow(/desconocida/);
    });

    test("en dos fases ninguna replica, vieja o nueva, rechaza un token valido en ningun momento", () => {
      const sign = (r, sub) => r.sign({ sub }, { expiresIn: "15m" });
      const verifies = (fleet, token) => fleet.every((r) => r.verify(token));

      // Fase 1: TODAS las replicas reciben la llave nueva SOLO para verificar (activa sigue siendo A)
      const phase1 = () => new SecretsManager({ active: KEY_A, previous: [KEY_B] });
      const fleet = [phase1(), phase1(), phase1()];
      const tokenA = sign(fleet[0], "a");
      expect(verifies(fleet, tokenA)).toBeTruthy();

      // Fase 2: se pasa la activa a B replica por replica (flota MEZCLADA en medio del despliegue)
      const phase2 = () => new SecretsManager({ active: KEY_B, previous: [KEY_A] });
      fleet[0] = phase2();
      const tokenB = sign(fleet[0], "b"); // firmado por una replica ya migrada
      expect(verifies(fleet, tokenB)).toBeTruthy(); // las replicas aun en fase 1 lo aceptan
      expect(verifies(fleet, tokenA)).toBeTruthy(); // y las migradas siguen aceptando lo viejo
      fleet[1] = phase2();
      fleet[2] = phase2();
      expect(verifies(fleet, tokenA)).toBeTruthy();
      expect(verifies(fleet, tokenB)).toBeTruthy();

      // Fase 3: expiro el token mas longevo -> se retira la llave vieja
      fleet.forEach((r) => r.retirePrevious());
      expect(() => fleet[0].verify(tokenA)).toThrow();
      expect(verifies(fleet, sign(fleet[1], "c"))).toBeTruthy();
    });
  });

  test("exige una llave activa", () => {
    expect(() => new SecretsManager({})).toThrow(/llave activa/);
  });
});
