const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Institution = require("../src/domain/Institution");
const AuditEntry = require("../src/domain/AuditEntry");
const { InstitutionRepository } = require("../src/infrastructure/InstitutionRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const logger = require("../src/tracing/logger");
const { InstitutionService, ValidationError, InstitutionNotFoundError, AlreadyInStateError } = require("../src/application/InstitutionService");

const valid = { nombre: "Universidad EAFIT", tipo: "universidad", nit: "890.901.389-5", correoContacto: "registro@eafit.edu.co" };
const NIT = "890901389";
const AHORA = new Date("2026-09-23T14:30:00Z");
const REVISOR = "Julian Giraldo";
const MOTIVO = "carta membretada + correo del dominio institucional, revisado en la afiliacion";

let mongoServer;
let service;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
afterEach(async () => {
  logger.resetSink();
  await mongoose.connection.dropDatabase();
});
beforeEach(async () => {
  await Promise.all([Institution.createIndexes(), AuditEntry.createIndexes()]);
  service = new InstitutionService({
    institutionRepository: new InstitutionRepository(),
    auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
    now: () => AHORA,
  });
});

const registrar = (overrides = {}) => service.register({ ...valid, ...overrides });
const verificar = (input = {}, options = {}) => service.verify({ nit: NIT, decididaPor: REVISOR, motivo: MOTIVO, ...input }, options);
const revocar = (input = {}, options = {}) => service.revokeVerification({ nit: NIT, decididaPor: REVISOR, motivo: "cese del convenio", ...input }, options);
const enBase = () => Institution.findOne({ nit: NIT }).lean();

describe("InstitutionService.verify() -- verificar una entidad existente (ADR-07)", () => {
  test("marca verificada:true y guarda fecha, responsable y motivo", async () => {
    const { institutionId } = await registrar();

    const res = await verificar();

    expect(res).toMatchObject({ status: "aplicada", verificada: true });
    expect(res.institucion).toMatchObject({ institutionId, nit: NIT, verificada: true, verificadaPor: REVISOR, motivoVerificacion: MOTIVO });
    const doc = await enBase();
    expect(doc.verificada).toBe(true);
    expect(doc.verificadaEn.toISOString()).toBe(AHORA.toISOString());
    expect(doc.verificadaPor).toBe(REVISOR);
    expect(doc.motivoVerificacion).toBe(MOTIVO);
  });

  test("acepta el NIT en cualquiera de sus formas (con/sin puntos, con/sin digito de verificacion)", async () => {
    await registrar();

    await verificar({ nit: "890.901.389-5" });

    expect((await enBase()).verificada).toBe(true);
  });

  test("la simulacion (dryRun) NO escribe nada, pero confirma que la entidad existe", async () => {
    await registrar();

    const res = await verificar({}, { dryRun: true });

    expect(res.status).toBe("dry-run");
    expect(res.institucion.nombre).toBe("Universidad EAFIT");
    const doc = await enBase();
    expect(doc.verificada).toBe(false);
    expect(doc.verificadaEn).toBeNull();
    expect(doc.verificadaPor).toBeNull();
  });

  test("en simulacion el motivo es opcional (todavia no se escribe nada); con confirmacion es obligatorio", async () => {
    await registrar();

    await expect(verificar({ motivo: undefined }, { dryRun: true })).resolves.toMatchObject({ status: "dry-run" });
    await expect(verificar({ motivo: undefined })).rejects.toThrow(ValidationError);
  });

  test("el registro NO verifica: una entidad recien registrada nace sin verificar y sin rastro de decision", async () => {
    await registrar();

    const doc = await enBase();
    expect(doc).toMatchObject({ verificada: false, verificadaEn: null, verificadaPor: null, motivoVerificacion: null });
  });
});

describe("Institucion inexistente", () => {
  test("verificar un NIT no registrado -> InstitutionNotFoundError y no se crea nada", async () => {
    const err = await verificar({ nit: "899999068" }).catch((e) => e);

    expect(err).toBeInstanceOf(InstitutionNotFoundError);
    expect(err.message).toMatch(/899999068/);
    expect(await Institution.countDocuments()).toBe(0);
  });

  test("revocar un NIT no registrado -> el mismo error", async () => {
    await expect(revocar({ nit: "899999068" })).rejects.toThrow(InstitutionNotFoundError);
  });

  test("tambien en simulacion: no se puede simular sobre algo que no existe", async () => {
    await expect(verificar({ nit: "899999068" }, { dryRun: true })).rejects.toThrow(InstitutionNotFoundError);
  });
});

describe("Idempotencia: ya estaba en ese estado", () => {
  test("verificar una entidad YA verificada -> AlreadyInStateError y no se reescribe la decision original", async () => {
    await registrar();
    await verificar();
    const original = await enBase();

    const err = await service
      .verify({ nit: NIT, decididaPor: "Otra Persona", motivo: "otro motivo distinto del original" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AlreadyInStateError);
    expect(err.verificada).toBe(true);
    const doc = await enBase();
    expect(doc.verificadaPor).toBe(original.verificadaPor); // sigue siendo la decision original
    expect(doc.motivoVerificacion).toBe(original.motivoVerificacion);
  });

  test("revocar una entidad NO verificada -> AlreadyInStateError y nada cambia", async () => {
    await registrar();

    const err = await revocar().catch((e) => e);

    expect(err).toBeInstanceOf(AlreadyInStateError);
    expect(err.verificada).toBe(false);
    expect(await enBase()).toMatchObject({ verificada: false, verificadaPor: null });
  });

  test("CONCURRENCIA: 5 verificaciones simultaneas -> exactamente 1 aplicada y 4 sin cambios", async () => {
    await registrar();

    const results = await Promise.all(Array.from({ length: 5 }, () => verificar().catch((e) => e)));

    expect(results.filter((r) => r.status === "aplicada")).toHaveLength(1);
    expect(results.filter((r) => r instanceof AlreadyInStateError)).toHaveLength(4);
    expect((await enBase()).verificada).toBe(true);
  });
});

describe("InstitutionService.revokeVerification()", () => {
  test("revoca una entidad verificada y deja constancia de la nueva decision", async () => {
    await registrar();
    await verificar();

    const res = await revocar({ motivo: "cese del convenio con el operador" });

    expect(res).toMatchObject({ status: "aplicada", verificada: false });
    const doc = await enBase();
    expect(doc.verificada).toBe(false);
    expect(doc.motivoVerificacion).toBe("cese del convenio con el operador");
    expect(doc.verificadaEn.toISOString()).toBe(AHORA.toISOString()); // fecha de la ULTIMA decision
  });

  test("se puede volver a verificar despues de revocar (el ciclo no queda bloqueado)", async () => {
    await registrar();
    await verificar();
    await revocar();

    await expect(verificar({ motivo: "convenio renovado y documentacion revisada" })).resolves.toMatchObject({ verificada: true });
    expect((await enBase()).verificada).toBe(true);
  });

  test("la simulacion de una revocacion no cambia nada", async () => {
    await registrar();
    await verificar();

    await revocar({}, { dryRun: true });

    expect((await enBase()).verificada).toBe(true);
  });
});

describe("Validacion de argumentos (no se consulta ni se escribe nada)", () => {
  test.each([
    ["NIT ausente", { nit: undefined }, /NIT/],
    ["NIT con letras", { nit: "ABC" }, /NIT/],
    ["NIT con digito de verificacion incorrecto", { nit: "890.901.389-9" }, /no coincide/],
    ["responsable ausente", { decididaPor: undefined }, /decididaPor/],
    ["responsable muy corto", { decididaPor: "J" }, /decididaPor/],
    ["responsable enorme", { decididaPor: "x".repeat(121) }, /decididaPor/],
    ["motivo muy corto", { motivo: "ok" }, /motivo/],
    ["motivo enorme", { motivo: "x".repeat(501) }, /motivo/],
  ])("%s -> ValidationError", async (_name, override, pattern) => {
    await registrar();

    const err = await verificar(override).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(pattern);
    expect((await enBase()).verificada).toBe(false);
  });

  test("informa TODOS los problemas a la vez, como el registro", async () => {
    const err = await verificar({ nit: "basura", decididaPor: "", motivo: "x" }).catch((e) => e);

    expect(err.problems.length).toBeGreaterThanOrEqual(3);
  });

  test("el motivo y el responsable se limpian de saltos de linea y espacios repetidos", async () => {
    await registrar();

    await verificar({ decididaPor: "  Julian\r\nGiraldo ", motivo: "revision\tpresencial   del  convenio" });

    const doc = await enBase();
    expect(doc.verificadaPor).toBe("Julian Giraldo");
    expect(doc.motivoVerificacion).toBe("revision presencial del convenio");
  });
});

describe("Bitacora (HT-04): la decision la toma el OPERADOR, no la entidad", () => {
  test("una verificacion exitosa queda como actorType 'sistema', con el responsable como actor y el motivo", async () => {
    const { institutionId } = await registrar();

    await verificar();

    const entry = await AuditEntry.findOne({ action: "institucion.verificar" }).lean();
    expect(entry).toMatchObject({
      actor: REVISOR,
      actorType: "sistema",
      action: "institucion.verificar",
      resource: `institucion:${institutionId}`,
      resourceOwner: NIT,
      outcome: "exito",
    });
    expect(entry.metadata.motivo).toBe(MOTIVO);
    expect(entry.timestamp).toBeInstanceOf(Date);
  });

  test("una revocacion queda con su propia accion", async () => {
    await registrar();
    await verificar();

    await revocar();

    const entry = await AuditEntry.findOne({ action: "institucion.revocar_verificacion" }).lean();
    expect(entry).toMatchObject({ actorType: "sistema", outcome: "exito" });
  });

  test("un NIT inexistente queda como fallo y un estado repetido como rechazo", async () => {
    await verificar({ nit: "899999068" }).catch(() => {});
    await registrar();
    await verificar();
    await verificar().catch(() => {});

    expect(await AuditEntry.findOne({ outcome: "fallo" }).lean()).toMatchObject({ reason: "nit_no_registrado" });
    expect(await AuditEntry.findOne({ outcome: "rechazo" }).lean()).toMatchObject({ reason: "sin_cambios" });
  });

  test("la simulacion NO escribe en la bitacora (no hubo decision)", async () => {
    await registrar();

    await verificar({}, { dryRun: true });

    expect(await AuditEntry.countDocuments({ action: "institucion.verificar" })).toBe(0);
  });

  test("la verificacion no cuenta como acceso fuera de politica: el historial queda completo y append-only", async () => {
    await registrar();
    await verificar();
    await revocar();

    const entries = await AuditEntry.find({ actorType: "sistema" }).sort({ timestamp: 1 }).lean();
    expect(entries).toHaveLength(2);
    // La bitacora conserva AMBAS decisiones aunque el documento solo guarde la ultima.
    expect(entries.map((e) => e.action)).toEqual(["institucion.verificar", "institucion.revocar_verificacion"]);
  });

  test("si la bitacora falla, la verificacion ya aplicada no se cae", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));
    const s = new InstitutionService({
      institutionRepository: new InstitutionRepository(),
      auditLogger: { record: async () => { throw new Error("mongo caido"); } },
      now: () => AHORA,
    });
    await s.register(valid);

    await expect(s.verify({ nit: NIT, decididaPor: REVISOR, motivo: MOTIVO })).resolves.toMatchObject({ status: "aplicada" });
    expect(lines.join("\n")).toContain("audit.write_failed");
  });

  test("los logs no contienen el NIT, el nombre ni el motivo de la entidad", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));
    await registrar();

    await verificar();

    const dump = lines.join("\n");
    for (const pii of [NIT, "Universidad EAFIT", MOTIVO]) expect(dump).not.toContain(pii);
  });
});

describe("Relacion con la autenticacion: son independientes (ADR-07)", () => {
  test("verificar NO toca la credencial ni el estado de bloqueo de la entidad", async () => {
    await service.register({ ...valid, password: "Clave-institucional-123" });
    const antes = await enBase();

    await verificar();

    const despues = await enBase();
    expect(despues.passwordHash).toBe(antes.passwordHash);
    expect(despues.intentosFallidos).toBe(antes.intentosFallidos);
    expect(despues.bloqueadoHasta).toBe(antes.bloqueadoHasta);
  });

  test("hasInstitutionalFolder() sigue sin mirar `verificada` (sigue siendo decision de HU-06.2)", async () => {
    await registrar();

    await expect(service.hasInstitutionalFolder({ nit: NIT })).resolves.toBe(true); // sin verificar

    await verificar();
    await expect(service.hasInstitutionalFolder({ nit: NIT })).resolves.toBe(true); // verificada: mismo resultado
  });
});
