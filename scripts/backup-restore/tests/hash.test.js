const { sha256 } = require("../src/hash");

describe("sha256()", () => {
  test("del buffer vacio da el hash conocido de la cadena vacia", () => {
    expect(sha256(Buffer.alloc(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("es determinista: el mismo contenido siempre da el mismo hash", () => {
    const buf = Buffer.from("HT-02", "utf8");
    expect(sha256(buf)).toBe(sha256(Buffer.from("HT-02", "utf8")));
  });

  test("un solo bit distinto cambia el hash por completo (efecto avalancha)", () => {
    const a = sha256(Buffer.from([0x00]));
    const b = sha256(Buffer.from([0x01]));
    expect(a).not.toBe(b);
  });

  test("siempre 64 caracteres hexadecimales", () => {
    expect(sha256(Buffer.from("cualquier cosa"))).toMatch(/^[0-9a-f]{64}$/);
  });
});
