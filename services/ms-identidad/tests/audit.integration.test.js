const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AuditEntry = require("../src/domain/AuditEntry");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const AuditQueryService = require("../src/application/AuditQueryService");

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe("Bitacora de auditoria contra Mongo (integracion)", () => {
  test("persiste una entrada completa y la recupera con su timestamp", async () => {
    const logger = new AuditLogger({ auditRepository: new AuditRepository() });

    await logger.record({
      actor: "555",
      action: "ciudadano.registrar",
      outcome: "exito",
      resource: "ciudadano:555",
      resourceOwner: "555",
    });

    const [stored] = await AuditEntry.find().lean();
    expect(stored).toMatchObject({ actor: "555", action: "ciudadano.registrar", outcome: "exito" });
    expect(stored.timestamp).toBeInstanceOf(Date);
  });

  test("es append-only: no permite modificar una entrada existente", async () => {
    const entry = await AuditEntry.create({ actor: "1", action: "x", outcome: "exito" });

    entry.outcome = "fallo";
    await expect(entry.save()).rejects.toThrow("append-only");
    await expect(AuditEntry.updateOne({ _id: entry._id }, { outcome: "fallo" })).rejects.toThrow("append-only");
  });

  test("es append-only: no permite borrar entradas", async () => {
    await AuditEntry.create({ actor: "1", action: "x", outcome: "exito" });

    await expect(AuditEntry.deleteMany({})).rejects.toThrow("append-only");
    expect(await AuditEntry.countDocuments()).toBe(1);
  });

  test("el servicio de consulta filtra por periodo y detecta una violacion real", async () => {
    const repo = new AuditRepository();
    await AuditEntry.create({
      actor: "1",
      action: "documento.descargar",
      resourceOwner: "2",
      outcome: "exito",
      timestamp: new Date("2026-09-10T12:00:00Z"),
    });
    await AuditEntry.create({
      actor: "3",
      action: "documento.descargar",
      resourceOwner: "3",
      outcome: "exito",
      timestamp: new Date("2026-10-10T12:00:00Z"),
    });

    const service = new AuditQueryService({ auditRepository: repo });

    const september = await service.verifyNoOutOfPolicyAccess({
      from: new Date("2026-09-01"),
      to: new Date("2026-09-30"),
    });
    expect(september.compliant).toBe(false);
    expect(september.totalEntries).toBe(1);

    const october = await service.verifyNoOutOfPolicyAccess({
      from: new Date("2026-10-01"),
      to: new Date("2026-10-31"),
    });
    expect(october.compliant).toBe(true);
  });
});
