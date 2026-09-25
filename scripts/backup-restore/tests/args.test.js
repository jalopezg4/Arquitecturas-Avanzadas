const { parseArgs } = require("../src/args");

const SPEC = { flags: ["force", "help"], values: ["backup", "mongo-uri"] };

describe("parseArgs()", () => {
  test("sin argumentos: todas las flags en false, sin valores, sin desconocidos", () => {
    const r = parseArgs([], SPEC);
    expect(r.flags).toEqual({ force: false, help: false });
    expect(r.values).toEqual({});
    expect(r.unknown).toEqual([]);
  });

  test("una flag booleana declarada queda en true", () => {
    expect(parseArgs(["--force"], SPEC).flags.force).toBe(true);
  });

  test("--clave=valor declarado se captura tal cual", () => {
    expect(parseArgs(["--backup=/ruta/x.tar.gz"], SPEC).values.backup).toBe("/ruta/x.tar.gz");
  });

  test("un valor con '=' dentro se preserva completo (solo el PRIMER '=' separa clave de valor)", () => {
    expect(parseArgs(["--mongo-uri=mongodb://user:pass@host:27017/db?a=b"], SPEC).values["mongo-uri"]).toBe("mongodb://user:pass@host:27017/db?a=b");
  });

  test("una opcion no declarada (flag o valor) cae en unknown", () => {
    expect(parseArgs(["--algo-raro"], SPEC).unknown).toEqual(["--algo-raro"]);
    expect(parseArgs(["--otra-cosa=x"], SPEC).unknown).toEqual(["--otra-cosa=x"]);
  });

  test("un argumento que no empieza por -- cae en unknown", () => {
    expect(parseArgs(["basura"], SPEC).unknown).toEqual(["basura"]);
  });

  test("una flag declarada usada CON '=' (mal uso) cae en unknown, no se acepta silenciosamente", () => {
    expect(parseArgs(["--force=si"], SPEC).unknown).toEqual(["--force=si"]);
  });

  test("un valor declarado usado SIN '=' (mal uso) cae en unknown", () => {
    expect(parseArgs(["--backup"], SPEC).unknown).toEqual(["--backup"]);
  });

  test("combinacion real: flags y valores mezclados, en cualquier orden", () => {
    const r = parseArgs(["--backup=x.tar.gz", "--force", "--mongo-uri=mongodb://localhost:27017"], SPEC);
    expect(r).toEqual({ flags: { force: true, help: false }, values: { backup: "x.tar.gz", "mongo-uri": "mongodb://localhost:27017" }, unknown: [] });
  });
});
