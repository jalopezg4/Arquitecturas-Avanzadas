/**
 * Prueba con el `tar` REAL del sistema (no un mock): es una herramienta siempre presente en el entorno
 * (Linux/CI y Git Bash de Windows), no "infraestructura" en el sentido de Docker/Mongo/MinIO.
 *
 * Cubre un bug real encontrado al probar backup.js de punta a punta: GNU tar interpreta un ":" en el
 * nombre del archivo como sintaxis de host remoto, asi que una ruta de Windows con unidad
 * (C:\Users\...\backup.tar.gz) fallaba con "Cannot connect to C: resolve failed" antes de agregar
 * --force-local.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pack, unpack, INNER_DIR } = require("../src/archive");

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "archive-test-"));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("empaqueta y desempaqueta preservando el contenido tal cual, incluso con ':' en la ruta de salida (bug real en Windows)", () => {
  const sourceDir = path.join(tmpRoot, INNER_DIR);
  fs.mkdirSync(path.join(sourceDir, "objects"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify({ hola: "mundo" }));
  fs.writeFileSync(path.join(sourceDir, "objects", "algo.bin"), Buffer.from([1, 2, 3]));

  // El nombre de salida SIEMPRE tiene ":" en Windows (unidad, p. ej. "C:\..."); en Linux no lo tiene, pero
  // el flag --force-local no molesta ahi tampoco. Se usa el path real que da os.tmpdir() (no se fuerza).
  const outFile = path.join(tmpRoot, "salida.tar.gz");
  pack(sourceDir, outFile);
  expect(fs.existsSync(outFile)).toBe(true);
  expect(fs.statSync(outFile).size).toBeGreaterThan(0);

  const destParent = fs.mkdtempSync(path.join(os.tmpdir(), "archive-test-dst-"));
  const restoredDir = unpack(outFile, destParent);

  expect(restoredDir).toBe(path.join(destParent, INNER_DIR));
  expect(JSON.parse(fs.readFileSync(path.join(restoredDir, "manifest.json"), "utf8"))).toEqual({ hola: "mundo" });
  expect(fs.readFileSync(path.join(restoredDir, "objects", "algo.bin"))).toEqual(Buffer.from([1, 2, 3]));

  fs.rmSync(destParent, { recursive: true, force: true });
});

test("pack() se niega si el directorio de origen no se llama exactamente 'backup-store'", () => {
  const badDir = path.join(tmpRoot, "otro-nombre");
  fs.mkdirSync(badDir);
  expect(() => pack(badDir, path.join(tmpRoot, "x.tar.gz"))).toThrow(/backup-store/);
});
