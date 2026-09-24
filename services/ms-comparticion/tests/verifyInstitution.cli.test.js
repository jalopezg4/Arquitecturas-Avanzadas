const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Institution = require("../src/domain/Institution");
const AuditEntry = require("../src/domain/AuditEntry");
const { InstitutionRepository } = require("../src/infrastructure/InstitutionRepository");
const { InstitutionService } = require("../src/application/InstitutionService");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "verify-institution.js");
const NIT = "890901389";
const valid = { nombre: "Universidad EAFIT", tipo: "universidad", nit: "890.901.389-5", correoContacto: "registro@eafit.edu.co" };
const MOTIVO = "carta membretada y correo del dominio institucional";

let mongoServer;
let uri;
let tmp;

beforeAll(async () => {
  // El script corre en OTRO proceso y se conecta por MONGO_URI: la base en memoria es la misma para los dos.
  mongoServer = await MongoMemoryServer.create();
  uri = mongoServer.getUri("ms-comparticion");
  await mongoose.connect(uri);
}, 180000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
beforeEach(async () => {
  await Promise.all([Institution.createIndexes(), AuditEntry.createIndexes()]);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vi-"));
});
afterEach(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  // dropDatabase y no deleteMany: `audit_logs` es append-only y el propio modelo bloquea los borrados (HT-04).
  await mongoose.connection.dropDatabase();
});

/** Ejecuta el script REAL en un proceso aparte, como lo haria el operador. */
function run(args = [], env = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(MONGO_URI|VERIFICATION_DECIDED_BY|REGISTRATION_TOKEN|ENTITY_)/.test(k)) delete base[k];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        env: { ...base, NODE_ENV: "test", MONGO_URI: uri, DOTENV_PATH: path.join(tmp, "no-existe.env"), LOG_SILENT: "1", VERIFICATION_DECIDED_BY: "Julian Giraldo", ...env },
        timeout: 60000,
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr, out: stdout + stderr })
    );
  });
}

const registrar = () => new InstitutionService({ institutionRepository: new InstitutionRepository() }).register(valid);
const enBase = () => Institution.findOne({ nit: NIT }).lean();

describe("ADR-07 script de verificacion de instituciones", () => {
  test("por defecto es una SIMULACION: localiza la entidad y NO modifica nada", async () => {
    await registrar();

    const r = await run([`--nit=${NIT}`]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("SIMULACION");
    expect(r.out).toContain("Universidad EAFIT");
    expect(r.out).toContain("--confirm");
    const doc = await enBase();
    expect(doc.verificada).toBe(false);
    expect(doc.verificadaEn).toBeNull();
    expect(await AuditEntry.countDocuments()).toBe(0);
  });

  test("la simulacion avisa de que el motivo sera obligatorio al confirmar", async () => {
    await registrar();

    const r = await run([`--nit=${NIT}`]);

    expect(r.out).toContain("--motivo es OBLIGATORIO");
  });

  test("con --confirm y --motivo verifica de verdad, y lo deja todo escrito", async () => {
    await registrar();

    const r = await run([`--nit=${NIT}`, "--confirm", `--motivo=${MOTIVO}`]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("VERIFICADA");
    const doc = await enBase();
    expect(doc.verificada).toBe(true);
    expect(doc.verificadaPor).toBe("Julian Giraldo");
    expect(doc.motivoVerificacion).toBe(MOTIVO);
    expect(doc.verificadaEn).toBeInstanceOf(Date);
  });

  test("--por gana sobre la variable de entorno y queda como responsable", async () => {
    await registrar();

    await run([`--nit=${NIT}`, "--confirm", `--motivo=${MOTIVO}`, "--por=Tomas Echavarria"]);

    expect((await enBase()).verificadaPor).toBe("Tomas Echavarria");
  });

  test("la verificacion queda en la bitacora como actorType 'sistema'", async () => {
    await registrar();

    await run([`--nit=${NIT}`, "--confirm", `--motivo=${MOTIVO}`]);

    const entry = await AuditEntry.findOne({ action: "institucion.verificar" }).lean();
    expect(entry).toMatchObject({ actorType: "sistema", actor: "Julian Giraldo", outcome: "exito", resourceOwner: NIT });
    expect(entry.traceId).toMatch(/^[A-Za-z0-9._-]{8,64}$/); // HT-06: la ejecucion tiene su propia traza
  });

  test("--revoke --confirm revoca la verificacion", async () => {
    await registrar();
    await run([`--nit=${NIT}`, "--confirm", `--motivo=${MOTIVO}`]);

    const r = await run([`--nit=${NIT}`, "--revoke", "--confirm", "--motivo=cese del convenio con el operador"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("REVOCADA");
    const doc = await enBase();
    expect(doc.verificada).toBe(false);
    expect(doc.motivoVerificacion).toBe("cese del convenio con el operador");
    expect(await AuditEntry.countDocuments({ action: "institucion.revocar_verificacion" })).toBe(1);
  });

  test("--revoke sin --confirm tambien es simulacion", async () => {
    await registrar();
    await run([`--nit=${NIT}`, "--confirm", `--motivo=${MOTIVO}`]);

    const r = await run([`--nit=${NIT}`, "--revoke"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("SIMULACION");
    expect((await enBase()).verificada).toBe(true);
  });

  test("salida 3 si la entidad YA estaba en ese estado (no se escribe nada)", async () => {
    await registrar();
    await run([`--nit=${NIT}`, "--confirm", `--motivo=${MOTIVO}`]);
    const antes = await enBase();

    const r = await run([`--nit=${NIT}`, "--confirm", "--motivo=otro motivo cualquiera distinto"]);

    expect(r.code).toBe(3);
    expect(r.out).toMatch(/ya estaba verificada/);
    expect((await enBase()).motivoVerificacion).toBe(antes.motivoVerificacion);
  });

  test("salida 3 al revocar una entidad que nunca se verifico", async () => {
    await registrar();

    const r = await run([`--nit=${NIT}`, "--revoke", "--confirm", "--motivo=no estaba verificada igualmente"]);

    expect(r.code).toBe(3);
    expect(r.out).toMatch(/ya estaba sin verificar/);
  });

  test("salida 2 si la institucion no existe", async () => {
    const r = await run(["--nit=899999068", "--confirm", `--motivo=${MOTIVO}`]);

    expect(r.code).toBe(2);
    expect(r.out).toMatch(/No hay ninguna institucion registrada/);
    expect(await Institution.countDocuments()).toBe(0);
  });

  test.each([
    ["sin --nit", []],
    ["NIT con letras", ["--nit=ABC"]],
    ["NIT con digito de verificacion incorrecto", ["--nit=890.901.389-9"]],
  ])("salida 2: argumentos invalidos (%s)", async (_name, args) => {
    await registrar();

    const r = await run([...args, "--confirm", `--motivo=${MOTIVO}`]);

    expect(r.code).toBe(2);
    expect((await enBase()).verificada).toBe(false);
  });

  test("salida 2 si se confirma sin --motivo (la evidencia es obligatoria)", async () => {
    await registrar();

    const r = await run([`--nit=${NIT}`, "--confirm"]);

    expect(r.code).toBe(2);
    expect(r.out).toMatch(/motivo/);
    expect((await enBase()).verificada).toBe(false);
  });

  test("salida 2 con una opcion desconocida, y no se toca la base ni se conecta", async () => {
    await registrar();

    const r = await run([`--nit=${NIT}`, "--confirm", `--motivo=${MOTIVO}`, "--forzar"]);

    expect(r.code).toBe(2);
    expect(r.out).toContain("Opcion desconocida");
    expect((await enBase()).verificada).toBe(false);
  });

  test("el motivo no aparece en stdout mas que en el resumen de la entidad, y nunca la contrasena", async () => {
    await new InstitutionService({ institutionRepository: new InstitutionRepository() }).register({ ...valid, password: "Clave-institucional-123" });

    const r = await run([`--nit=${NIT}`, "--confirm", `--motivo=${MOTIVO}`]);

    expect(r.out).not.toContain("Clave-institucional-123");
    expect(r.out).not.toContain("passwordHash");
  });

  test("avisa de que los tokens ya emitidos conservan el estado anterior (ventana de 15 minutos)", async () => {
    await registrar();

    const r = await run([`--nit=${NIT}`, "--confirm", `--motivo=${MOTIVO}`]);

    expect(r.out).toMatch(/15 minutos/);
  });
});
