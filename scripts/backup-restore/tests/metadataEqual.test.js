const { metadataEqual } = require("../src/metadataEqual");

describe("metadataEqual()", () => {
  test("dos objetos vacios son iguales", () => {
    expect(metadataEqual({}, {})).toBe(true);
    expect(metadataEqual(undefined, undefined)).toBe(true);
  });

  test("mismas claves y valores, MISMO orden -> iguales", () => {
    expect(metadataEqual({ a: "1", b: "2" }, { a: "1", b: "2" })).toBe(true);
  });

  test("mismas claves y valores, orden DISTINTO -> iguales (el hallazgo real de la prueba con MinIO)", () => {
    // Verificado experimentalmente: MinIO devolvio "{ht02-doc-id, ht02-owner}" cuando se subio como
    // "{ht02-owner, ht02-doc-id}" -- JSON.stringify() directo daba un falso negativo aqui.
    expect(metadataEqual({ "ht02-doc-id": "12345", "ht02-owner": "prueba" }, { "ht02-owner": "prueba", "ht02-doc-id": "12345" })).toBe(true);
  });

  test("un valor distinto -> NO son iguales", () => {
    expect(metadataEqual({ a: "1" }, { a: "2" })).toBe(false);
  });

  test("una clave de mas o de menos -> NO son iguales", () => {
    expect(metadataEqual({ a: "1" }, { a: "1", b: "2" })).toBe(false);
    expect(metadataEqual({ a: "1", b: "2" }, { a: "1" })).toBe(false);
  });

  test("misma cantidad de claves pero distintas -> NO son iguales (no basta con contar)", () => {
    expect(metadataEqual({ a: "1" }, { b: "1" })).toBe(false);
  });
});
