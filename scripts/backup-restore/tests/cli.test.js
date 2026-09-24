/**
 * Pruebas de CLI que NO requieren Docker/Mongo/MinIO: solo --help y validacion de argumentos (mismo patron
 * que publishEndpoint.cli.test.js / verifyInstitution.cli.test.js -- ejecutar el script REAL como proceso
 * hijo, no reimplementar su logica de argumentos por separado).
 */
const path = require("path");
const { execFile } = require("child_process");

const BACKUP = path.resolve(__dirname, "..", "backup.js");
const RESTORE = path.resolve(__dirname, "..", "restore-verify.js");

function run(script, args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { timeout: 15000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr, out: stdout + stderr }));
  });
}

describe("backup.js -- CLI", () => {
  test("--help sale con 0 y muestra el uso, sin tocar nada", async () => {
    const r = await run(BACKUP, ["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Uso: node backup.js");
    expect(r.out).toContain("--skip-mongo");
    expect(r.out).toContain("--skip-minio");
  });

  test("una opcion desconocida sale con 1, sin intentar nada", async () => {
    const r = await run(BACKUP, ["--algo-que-no-existe"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Opcion desconocida");
  });
});

describe("restore-verify.js -- CLI", () => {
  test("--help sale con 0 y muestra el uso", async () => {
    const r = await run(RESTORE, ["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Uso: node restore-verify.js");
  });

  test("sin --backup sale con 1 (obligatorio)", async () => {
    const r = await run(RESTORE, []);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--backup/);
  });

  test("con --backup pero SIN --mongo-uri sale con 1: no hay valor por defecto para el destino (a proposito)", async () => {
    const r = await run(RESTORE, ["--backup=x.tar.gz", "--minio-bucket=algo"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--mongo-uri/);
  });

  test("con --backup pero SIN --minio-bucket sale con 1: no hay valor por defecto para el bucket destino (a proposito)", async () => {
    const r = await run(RESTORE, ["--backup=x.tar.gz", "--mongo-uri=mongodb://localhost:27017"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--minio-bucket/);
  });

  test("--skip-mongo --skip-minio con --backup inexistente sale con 1 sin necesitar mongo-uri/minio-bucket", async () => {
    const r = await run(RESTORE, ["--backup=no-existe.tar.gz", "--skip-mongo", "--skip-minio"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No existe/);
  });

  test("una opcion desconocida sale con 1", async () => {
    const r = await run(RESTORE, ["--backup=x.tar.gz", "--mongo-uri=x", "--minio-bucket=y", "--algo-raro"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Opcion desconocida");
  });
});
