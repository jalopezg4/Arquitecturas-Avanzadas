const { safeLocalName } = require("../src/safeLocalName");

describe("safeLocalName()", () => {
  test("es determinista: la misma key siempre da el mismo nombre", () => {
    expect(safeLocalName("ciudadanos/x/y.pdf")).toBe(safeLocalName("ciudadanos/x/y.pdf"));
  });

  test("keys distintas dan nombres distintos", () => {
    expect(safeLocalName("a")).not.toBe(safeLocalName("b"));
  });

  test("nunca contiene la key original (evita filtrar datos por el nombre de archivo)", () => {
    const key = "ciudadanos/secreto-123/y.pdf";
    expect(safeLocalName(key)).not.toContain("secreto");
    expect(safeLocalName(key)).not.toContain("/");
  });

  test.each([
    ["con espacios y caracteres especiales", "pruebas/año 2026/archivo (1) #raro & extraño.txt"],
    ["con caracteres reservados de Windows", 'a:b*c?d"e<f>g|h.txt'],
    ["vacia", ""],
    ["muy larga", "x".repeat(2000)],
    ["con saltos de linea", "a\nb\r\nc"],
  ])("produce un nombre de archivo VALIDO para una key %s", (_name, key) => {
    const name = safeLocalName(key);
    expect(name).toMatch(/^[0-9a-f]{40}\.bin$/); // sha1 hex (40) + extension fija
    expect(name).not.toMatch(/[\s/\\:*?"<>|]/); // ningun caracter problematico de nombre de archivo
  });
});
