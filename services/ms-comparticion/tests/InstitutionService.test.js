const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Institution = require("../src/domain/Institution");
const AuditEntry = require("../src/domain/AuditEntry");
const { InstitutionRepository } = require("../src/infrastructure/InstitutionRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const logger = require("../src/tracing/logger");
const { InstitutionService, ValidationError, ConflictError } = require("../src/application/InstitutionService");

const valid = { nombre: "Universidad EAFIT", tipo: "universidad", nit: "890.901.389-5", correoContacto: "registro@eafit.edu.co" };
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
  await Promise.all([Institution.createIndexes(), AuditEntry.createIndexes()]); // dropDatabase() borra los indices unicos
  service = new InstitutionService({ institutionRepository: new InstitutionRepository(), auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }), now: () => new Date("2026-09-20T10:00:00Z") });
});

describe("InstitutionService.register() crea entidad y carpeta institucional", () => {
  test("devuelve {institutionId} y guarda la entidad con su carpeta institucional propia, activa", async () => {
    const res = await service.register(valid);

    expect(Object.keys(res)).toEqual(["institutionId"]);
    const doc = await Institution.findById(res.institutionId).lean();
    expect(doc).toMatchObject({ nombre: "Universidad EAFIT", tipo: "universidad", nit: "890901389", nitDv: "5", correoContacto: "registro@eafit.edu.co", verificada: false });
    expect(doc.carpeta).toMatchObject({ estado: "activa" });
    expect(doc.carpeta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.carpeta.creadaEn.toISOString()).toBe("2026-09-20T10:00:00.000Z");
  });

  test("cada entidad recibe una carpeta DISTINTA", async () => {
    await service.register(valid);
    await service.register({ ...valid, nit: "899999068", nombre: "Ecopetrol", tipo: "empresa" });

    const folders = (await Institution.find().lean()).map((i) => i.carpeta.id);
    expect(new Set(folders).size).toBe(2);
  });

  test("nace SIN verificar (el registro es autodeclarado) aunque el cliente intente mandar verificada:true o una carpeta propia", async () => {
    const { institutionId } = await service.register({ ...valid, verificada: true, carpeta: { id: "mia", estado: "activa" }, _id: "6aaea1c04c9de9c4c34f6b52", isAdmin: true });

    const doc = await Institution.findById(institutionId).lean();
    expect(doc.verificada).toBe(false);
    expect(doc.carpeta.id).not.toBe("mia");
    expect(String(doc._id)).not.toBe("6aaea1c04c9de9c4c34f6b52");
    expect(doc).not.toHaveProperty("isAdmin");
  });

  test("guarda los datos opcionales (telefono, direccion) y normaliza nombre, tipo y correo", async () => {
    const { institutionId } = await service.register({ nombre: "  Notaria   Setenta\r\ny Dos ", tipo: "NOTARIA", nit: "899999068", correoContacto: " Notaria72@Correo.CO ", telefono: "+57 (604) 444-5566", direccion: "Cra 43A  # 1 Sur-50" });

    const doc = await Institution.findById(institutionId).lean();
    expect(doc).toMatchObject({ nombre: "Notaria Setenta y Dos", tipo: "notaria", correoContacto: "notaria72@correo.co", telefono: "+57 (604) 444-5566", direccion: "Cra 43A # 1 Sur-50" });
  });

  test("la entidad y su carpeta son UNA sola escritura: si la escritura falla no queda nada a medias", async () => {
    jest.spyOn(Institution, "create").mockRejectedValueOnce(new Error("mongo caido"));

    await expect(service.register(valid)).rejects.toThrow("mongo caido");

    expect(await Institution.countDocuments()).toBe(0);
    jest.restoreAllMocks();
  });
});

describe("NIT unico", () => {
  test("registrar dos veces el mismo NIT -> ConflictError (409) y no se crea una segunda entidad", async () => {
    await service.register(valid);

    await expect(service.register(valid)).rejects.toThrow(ConflictError);
    expect(await Institution.countDocuments()).toBe(1);
  });

  test("las distintas formas del mismo NIT (con/sin puntos, con/sin DV) cuentan como duplicado", async () => {
    await service.register({ ...valid, nit: "890.901.389-5" });

    for (const nit of ["890901389", "890901389-5", "890.901.389"]) {
      await expect(service.register({ ...valid, nit })).rejects.toThrow(ConflictError);
    }
    expect(await Institution.countDocuments()).toBe(1);
  });

  test("CONCURRENCIA: 8 registros simultaneos del mismo NIT -> exactamente 1 creado y 7 conflictos (indice unico)", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => service.register(valid).catch((e) => e)));

    expect(results.filter((r) => r.institutionId)).toHaveLength(1);
    expect(results.filter((r) => r instanceof ConflictError)).toHaveLength(7);
    expect(await Institution.countDocuments()).toBe(1);
  });

  test("NITs distintos conviven", async () => {
    await service.register(valid);
    await expect(service.register({ ...valid, nit: "899999068" })).resolves.toHaveProperty("institutionId");
  });
});

describe("Validacion (informa TODOS los problemas a la vez y no crea nada)", () => {
  test("un cuerpo vacio lista todos los campos obligatorios", async () => {
    const err = await service.register({}).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.problems.join(" | ")).toMatch(/nombre.*tipo.*NIT.*correoContacto/);
    expect(await Institution.countDocuments()).toBe(0);
  });

  test.each([
    ["nombre muy corto", { nombre: "ab" }, /nombre/],
    ["nombre enorme", { nombre: "x".repeat(201) }, /nombre/],
    ["nombre que no es texto", { nombre: 12345 }, /nombre/],
    ["tipo desconocido", { tipo: "gobierno" }, /tipo debe ser/],
    ["NIT con digito de verificacion incorrecto", { nit: "890.901.389-9" }, /no coincide/],
    ["NIT con letras", { nit: "ABC" }, /NIT/],
    ["correo invalido", { correoContacto: "no-es-correo" }, /correoContacto/],
    ["correo con salto de linea (inyeccion de encabezados)", { correoContacto: "a@b.co\r\nBcc: x@y.co" }, /correoContacto/],
    ["correo con varios destinatarios", { correoContacto: "a@b.co, c@d.co" }, /correoContacto/],
    ["telefono invalido", { telefono: "llamame" }, /telefono/],
    ["direccion enorme", { direccion: "x".repeat(201) }, /direccion/],
  ])("%s", async (_name, override, pattern) => {
    const err = await service.register({ ...valid, ...override }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(pattern);
    expect(await Institution.countDocuments()).toBe(0);
  });

  test.each([[null], [undefined], ["texto"], [42], [[]]])("una entrada que no es un objeto (%j) da ValidationError, no un error interno", async (input) => {
    await expect(service.register(input)).rejects.toThrow(ValidationError);
  });

  test("un nombre con caracteres de control (\\r\\n) se limpia, no se rechaza ni se guarda con saltos de linea", async () => {
    const { institutionId } = await service.register({ ...valid, nombre: "Universidad\r\nEAFIT" });
    expect((await Institution.findById(institutionId).lean()).nombre).toBe("Universidad EAFIT");
  });
});

describe("InstitutionService.hasInstitutionalFolder() -- lo que HU-06.2 usa para elegir carpeta o correo", () => {
  test("true para una entidad registrada (entrega INTERNA), sin importar como se escriba el NIT", async () => {
    await service.register(valid);

    for (const nit of ["890.901.389-5", "890901389", "890901389-5"]) {
      await expect(service.hasInstitutionalFolder({ nit })).resolves.toBe(true);
    }
  });

  test("false para una entidad NO registrada (entonces se usa el envio por correo, RF-26)", async () => {
    await service.register(valid);
    await expect(service.hasInstitutionalFolder({ nit: "899999068" })).resolves.toBe(false);
  });

  test("un NIT invalido o ausente es 'no tiene carpeta', no un error: quien entrega debe poder caer al correo", async () => {
    for (const input of [{ nit: "basura" }, { nit: "" }, { nit: null }, {}, undefined]) {
      await expect(service.hasInstitutionalFolder(input)).resolves.toBe(false);
    }
  });
});

describe("Bitacora (HT-04) y logs", () => {
  test("el registro queda en la bitacora como accion de la entidad, con su NIT y el id de la institucion", async () => {
    const { institutionId } = await service.register(valid);

    const entry = await AuditEntry.findOne({ action: "institucion.registrar" }).lean();
    expect(entry).toMatchObject({ actor: "890901389", actorType: "entidad", outcome: "exito", resource: `institucion:${institutionId}` });
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(JSON.stringify(entry)).not.toContain("registro@eafit.edu.co");
  });

  test("un duplicado queda como rechazo (nit_duplicado)", async () => {
    await service.register(valid);
    await service.register(valid).catch(() => {});

    const entry = await AuditEntry.findOne({ outcome: "rechazo" }).lean();
    expect(entry).toMatchObject({ action: "institucion.registrar", reason: "nit_duplicado" });
  });

  test("si la bitacora falla, el registro ya hecho no se cae", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(l));
    const s = new InstitutionService({ institutionRepository: new InstitutionRepository(), auditLogger: { record: async () => { throw new Error("mongo caido"); } } });

    await expect(s.register(valid)).resolves.toHaveProperty("institutionId");
    expect(lines.join("\n")).toContain("audit.write_failed");
  });
});
