const { compareFingerprints } = require("../src/mongoRestoreVerify");

const base = () => ({
  "ms-documentos": { documents: { count: 2, contentHash: "hashA" }, folders: { count: 1, contentHash: "hashB" } },
});

describe("compareFingerprints() -- deteccion de diferencias de contenido, no solo de conteo", () => {
  test("dos huellas identicas -> ok", () => {
    expect(compareFingerprints(base(), base())).toEqual({ ok: true, problems: [] });
  });

  test("detecta una BASE faltante en el destino", () => {
    const r = compareFingerprints(base(), {});
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ type: "bases", esperado: ["ms-documentos"], real: [] }]);
  });

  test("detecta una BASE de mas en el destino (sobrante)", () => {
    const r = compareFingerprints(base(), { ...base(), "otra-base": {} });
    expect(r.problems[0].type).toBe("bases");
  });

  test("detecta una COLECCION faltante dentro de una base que si existe", () => {
    const actual = { "ms-documentos": { documents: base()["ms-documentos"].documents } }; // sin "folders"
    const r = compareFingerprints(base(), actual);
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual({ type: "colecciones", db: "ms-documentos", esperado: ["documents", "folders"], real: ["documents"] });
  });

  test("MISMO conteo, HASH distinto -> se detecta como diferencia de CONTENIDO (no solo contar no basta)", () => {
    const actual = { "ms-documentos": { documents: { count: 2, contentHash: "hashA-DISTINTO" }, folders: base()["ms-documentos"].folders } };
    const r = compareFingerprints(base(), actual);
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual({ type: "contenido", db: "ms-documentos", col: "documents", esperado: "hashA", real: "hashA-DISTINTO" });
  });

  test("conteo distinto tambien se detecta, por separado del contenido", () => {
    const actual = { "ms-documentos": { documents: { count: 5, contentHash: "hashA" }, folders: base()["ms-documentos"].folders } };
    const r = compareFingerprints(base(), actual);
    expect(r.problems).toContainEqual({ type: "conteo", db: "ms-documentos", col: "documents", esperado: 2, real: 5 });
  });

  test("dos bases vacias ({} vs {}) son iguales (caso: ninguna base de usuario, solo admin/local/config ya filtradas)", () => {
    expect(compareFingerprints({}, {})).toEqual({ ok: true, problems: [] });
  });
});
