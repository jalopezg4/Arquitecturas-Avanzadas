const AuditLogger = require("../src/infrastructure/AuditLogger");
const AuditQueryService = require("../src/application/AuditQueryService");

function makeFakeRepo(entries = []) {
  return {
    create: jest.fn(async (e) => e),
    findInPeriod: jest.fn(async () => entries),
  };
}

describe("AuditLogger.record()", () => {
  test("persiste accion, actor, timestamp y resultado", async () => {
    const repo = makeFakeRepo();
    const logger = new AuditLogger({ auditRepository: repo });

    await logger.record({ actor: "123", action: "sesion.iniciar", outcome: "exito", resource: "sesion:123" });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "123",
        action: "sesion.iniciar",
        outcome: "exito",
        resource: "sesion:123",
        timestamp: expect.any(Date),
      })
    );
  });

  test("acepta los tres resultados validos (exito, fallo, rechazo)", async () => {
    const repo = makeFakeRepo();
    const logger = new AuditLogger({ auditRepository: repo });
    for (const outcome of ["exito", "fallo", "rechazo"]) {
      await logger.record({ actor: "1", action: "x", outcome });
    }
    expect(repo.create).toHaveBeenCalledTimes(3);
  });

  test("rechaza un outcome invalido sin escribir nada", async () => {
    const repo = makeFakeRepo();
    const logger = new AuditLogger({ auditRepository: repo });

    await expect(logger.record({ actor: "1", action: "x", outcome: "quiza" })).rejects.toThrow("outcome");
    expect(repo.create).not.toHaveBeenCalled();
  });

  test("rechaza si falta el actor o la accion", async () => {
    const repo = makeFakeRepo();
    const logger = new AuditLogger({ auditRepository: repo });

    await expect(logger.record({ action: "x", outcome: "exito" })).rejects.toThrow("actor");
    await expect(logger.record({ actor: "1", outcome: "exito" })).rejects.toThrow("action");
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe("AuditQueryService.verifyNoOutOfPolicyAccess()", () => {
  test("cumple (compliant) cuando no hay accesos exitosos a recursos ajenos", async () => {
    const repo = makeFakeRepo([
      { actor: "1", resourceOwner: "1", outcome: "exito" },
      { actor: "2", resourceOwner: "2", outcome: "exito" },
    ]);
    const result = await new AuditQueryService({ auditRepository: repo }).verifyNoOutOfPolicyAccess();

    expect(result.compliant).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.totalEntries).toBe(2);
  });

  test("detecta como violacion un acceso EXITOSO a un recurso de otro ciudadano", async () => {
    const violating = { actor: "1", resourceOwner: "2", outcome: "exito", action: "documento.descargar" };
    const repo = makeFakeRepo([{ actor: "2", resourceOwner: "2", outcome: "exito" }, violating]);
    const result = await new AuditQueryService({ auditRepository: repo }).verifyNoOutOfPolicyAccess();

    expect(result.compliant).toBe(false);
    expect(result.violations).toEqual([violating]);
  });

  test("no cuenta como violacion un acceso delegado (ej. entidad emisora entregando un documento)", async () => {
    const repo = makeFakeRepo([{ actor: "entidad-x", resourceOwner: "2", outcome: "exito", delegated: true }]);
    const result = await new AuditQueryService({ auditRepository: repo }).verifyNoOutOfPolicyAccess();

    expect(result.compliant).toBe(true);
  });

  test("los intentos rechazados no son violaciones: se cuentan aparte como evidencia de que la politica funciona", async () => {
    const repo = makeFakeRepo([{ actor: "1", resourceOwner: "2", outcome: "rechazo" }]);
    const result = await new AuditQueryService({ auditRepository: repo }).verifyNoOutOfPolicyAccess();

    expect(result.compliant).toBe(true);
    expect(result.deniedAttempts).toBe(1);
  });

  test("consulta unicamente el periodo pedido", async () => {
    const repo = makeFakeRepo();
    const from = new Date("2026-09-01");
    const to = new Date("2026-09-30");

    await new AuditQueryService({ auditRepository: repo }).verifyNoOutOfPolicyAccess({ from, to });

    expect(repo.findInPeriod).toHaveBeenCalledWith({ from, to });
  });
});
