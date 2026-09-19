const { parseNit, checkDigit } = require("../src/domain/nit");

describe("checkDigit() -- digito de verificacion del NIT (modulo 11 de la DIAN)", () => {
  test.each([
    ["899999068", "1"], // Ecopetrol
    ["800197268", "4"], // DIAN
    ["860034313", "7"],
    ["890903938", "8"],
  ])("NIT base %s -> DV %s", (base, dv) => {
    expect(checkDigit(base)).toBe(dv);
  });

  test("el residuo 0 y 1 se quedan como estan (no 11 - r)", () => {
    // 899999068 da residuo 1 -> DV 1 (no 10); se comprueba con el caso real de arriba y con uno de residuo 0
    const zero = Array.from({ length: 200 }, (_, i) => String(100000 + i)).find((b) => checkDigit(b) === "0");
    expect(zero).toBeDefined();
  });
});

describe("parseNit()", () => {
  test.each([
    ["899.999.068-1", "899999068", "1"],
    ["899999068-1", "899999068", "1"],
    ["899999068", "899999068", "1"], // sin DV: se calcula
    ["  800.197.268-4 ", "800197268", "4"],
  ])("acepta %j", (raw, nit, dv) => {
    expect(parseNit(raw)).toEqual({ ok: true, nit, dv });
  });

  test("las formas con y sin puntos/DV son EL MISMO NIT (base para detectar duplicados)", () => {
    const forms = ["899.999.068-1", "899999068-1", "899999068", "899.999.068"];
    expect(new Set(forms.map((f) => parseNit(f).nit)).size).toBe(1);
  });

  test.each([
    ["digito de verificacion incorrecto", "899999068-2", /no coincide/],
    ["con letras", "89999906A", /solo puede llevar/],
    ["notacion cientifica", "1e9", /solo puede llevar/],
    ["con espacios en medio", "899 999 068", /solo puede llevar/],
    ["con signo", "-899999068", /solo puede llevar/],
    ["dos guiones", "899999068-1-1", /solo puede llevar/],
    ["DV de dos digitos", "899999068-10", /solo puede llevar/],
    ["puntos dobles", "899..999.068", /puntos mal ubicados/],
    ["punto al inicio", ".899999068", /puntos mal ubicados/],
    ["punto al final", "899999068.", /puntos mal ubicados/],
    ["demasiado corto", "12345", /entre 6 y 12/],
    ["demasiado largo", "1234567890123", /entre 6 y 12/],
    ["solo ceros", "000000000", /no es valido/],
    ["vacio", "", /solo puede llevar/],
    ["no es texto", 899999068, /obligatorio/],
    ["null", null, /obligatorio/],
    ["inyeccion", "899999068; DROP", /solo puede llevar/],
  ])("rechaza %s", (_name, raw, reason) => {
    const res = parseNit(raw);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(reason);
  });
});
