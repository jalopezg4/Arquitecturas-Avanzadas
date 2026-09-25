const fs = require("fs");
const os = require("os");
const path = require("path");
const { newManifest, validateManifest, readManifest, writeManifest, MANIFEST_VERSION } = require("../src/manifest");

describe("newManifest()", () => {
  test("crea la forma minima esperada, sin objetos ni mongo todavia", () => {
    const m = newManifest({ bucket: "carpeta-documentos" });
    expect(m.version).toBe(MANIFEST_VERSION);
    expect(typeof m.generatedAt).toBe("string");
    expect(m.minio).toEqual({ bucket: "carpeta-documentos", objects: [], errors: [] });
    expect(m.mongo).toBeNull();
  });

  test("NUNCA incluye campos de credenciales (nada de accessKey, secretKey, uri con password, etc.)", () => {
    const m = newManifest({ bucket: "x" });
    const dump = JSON.stringify(m).toLowerCase();
    for (const palabra of ["secret", "password", "accesskey", "mongodb://"]) {
      expect(dump).not.toContain(palabra);
    }
  });
});

describe("validateManifest()", () => {
  const valido = () => ({
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    minio: { bucket: "x", objects: [{ key: "a", size: 1, sha256: "abc", localFile: "f.bin" }], errors: [] },
    mongo: { size: 10, sha256: "abc", databases: {} },
  });

  test("un manifest bien formado no tiene problemas", () => {
    expect(validateManifest(valido())).toEqual([]);
  });

  test("null/undefined/no-objeto -> un problema, no una excepcion", () => {
    expect(validateManifest(null).length).toBeGreaterThan(0);
    expect(validateManifest(undefined).length).toBeGreaterThan(0);
    expect(validateManifest("texto").length).toBeGreaterThan(0);
  });

  test("version distinta se detecta", () => {
    expect(validateManifest({ ...valido(), version: 99 }).join()).toMatch(/version/);
  });

  test("falta minio.objects se detecta", () => {
    expect(validateManifest({ ...valido(), minio: {} }).join()).toMatch(/minio.objects/);
  });

  test.each(["key", "size", "sha256", "localFile"])("un objeto de minio sin '%s' se detecta", (campo) => {
    const m = valido();
    delete m.minio.objects[0][campo];
    expect(validateManifest(m).join()).toContain(campo);
  });

  test("mongo sin size/sha256 se detecta (si mongo esta presente)", () => {
    const m = valido();
    delete m.mongo.size;
    expect(validateManifest(m).join()).toMatch(/mongo.size/);
  });

  test("mongo:null es valido (--skip-mongo al respaldar)", () => {
    expect(validateManifest({ ...valido(), mongo: null })).toEqual([]);
  });
});

describe("writeManifest() / readManifest()", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("lo que se escribe se puede volver a leer identico", () => {
    const original = newManifest({ bucket: "carpeta-documentos" });
    original.minio.objects.push({ key: "a", size: 1, sha256: "x", localFile: "a.bin", contentType: "text/plain", metadata: {} });

    writeManifest(dir, original);
    const leido = readManifest(dir);

    expect(leido).toEqual(original);
  });
});
