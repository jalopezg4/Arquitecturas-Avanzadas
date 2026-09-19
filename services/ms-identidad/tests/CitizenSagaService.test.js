const { CitizenSagaService, ValidationError, ConflictError, ServiceUnavailableError } = require("../src/application/CitizenSagaService");

function makeFakeRepo(overrides = {}) {
  const store = new Map();
  return {
    findByDocumento: jest.fn(async (documento) => store.get(documento) || null),
    create: jest.fn(async (data) => {
      const citizen = { _id: "id-" + data.documento, ...data };
      store.set(data.documento, citizen);
      return citizen;
    }),
    markActive: jest.fn(async (id) => {
      const citizen = [...store.values()].find((c) => c._id === id);
      citizen.estado = "activo";
      return citizen;
    }),
    ...overrides,
  };
}

function makeFakeGovCarpeta(overrides = {}) {
  return {
    validateCitizen: jest.fn(async () => ({ available: true })),
    registerCitizen: jest.fn(async () => {}),
    unregisterCitizen: jest.fn(async () => {}),
    ...overrides,
  };
}

function makeFakePublisher() {
  return { publish: jest.fn(async () => {}) };
}

const validInput = {
  documento: 123,
  nombre: "Ana Gomez",
  direccion: "Cra 1 # 2-3",
  correo: "ana@example.com",
  password: "Sup3rSecreta!",
};

describe("CitizenSagaService.register()", () => {
  test("persiste en estado pendiente antes de llamar GovCarpeta (registerCitizen)", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta();
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await service.register(validInput);

    const createCallOrder = repo.create.mock.invocationCallOrder[0];
    const registerCallOrder = gov.registerCitizen.mock.invocationCallOrder[0];
    expect(createCallOrder).toBeLessThan(registerCallOrder);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ estado: "pendiente" }));
  });

  test("confirma estado activo solo tras 201 (mock exitoso) de registerCitizen", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta();
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    const result = await service.register(validInput);

    expect(repo.markActive).toHaveBeenCalled();
    expect(result).toEqual({ ciudadanoId: expect.any(String), direccionUnica: expect.any(String) });
  });

  test("ejecuta compensacion (unregisterCitizen) si falla tras confirmar en GovCarpeta", async () => {
    const repo = makeFakeRepo({
      markActive: jest.fn(async () => {
        throw new Error("fallo de BD al marcar activo");
      }),
    });
    const gov = makeFakeGovCarpeta();
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await expect(service.register(validInput)).rejects.toThrow();
    expect(gov.unregisterCitizen).toHaveBeenCalledWith(validInput.documento);
  });

  test("rechaza si GovCarpeta indica que el ciudadano ya esta afiliado (validateCitizen no disponible)", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta({ validateCitizen: jest.fn(async () => ({ available: false })) });
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await expect(service.register(validInput)).rejects.toThrow(ConflictError);
    expect(repo.create).not.toHaveBeenCalled();
  });

  test("rechaza con ValidationError si faltan campos requeridos", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta();
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await expect(service.register({ ...validInput, correo: undefined })).rejects.toThrow(ValidationError);
  });

  test("rechaza con ValidationError si documento no es un entero valido (string no numerica)", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta();
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await expect(service.register({ ...validInput, documento: "abc" })).rejects.toThrow(ValidationError);
    expect(gov.validateCitizen).not.toHaveBeenCalled();
  });

  test("rechaza con ValidationError si nombre no es un string (ej. numero)", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta();
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await expect(service.register({ ...validInput, nombre: 42 })).rejects.toThrow(ValidationError);
  });

  test("rechaza con ValidationError si password tiene menos de 8 caracteres", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta();
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await expect(service.register({ ...validInput, password: "1234567" })).rejects.toThrow(ValidationError);
  });

  test("rechaza con ConflictError si el documento ya existe localmente", async () => {
    const repo = makeFakeRepo();
    await repo.create({ ...validInput, direccionUnica: "x@carpetacolombia.co", passwordHash: "h", estado: "activo" });
    const gov = makeFakeGovCarpeta();
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await expect(service.register(validInput)).rejects.toThrow(ConflictError);
  });

  test("responde ServiceUnavailableError si GovCarpeta no responde en la validacion", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta({
      validateCitizen: jest.fn(async () => {
        throw new Error("timeout");
      }),
    });
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await expect(service.register(validInput)).rejects.toThrow(ServiceUnavailableError);
  });

  test("publica evento CiudadanoRegistrado solo si el estado final es activo", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta();
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await service.register(validInput);

    expect(publisher.publish).toHaveBeenCalledWith(
      "ciudadano.registrado",
      expect.objectContaining({ documento: validInput.documento })
    );
  });

  test("NO falla el registro si eventPublisher.publish() rechaza (evento no es camino critico, ADR-04)", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta();
    const publisher = { publish: jest.fn(async () => { throw new Error("RabbitMQ no disponible"); }) };
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    const result = await service.register(validInput);

    expect(result).toEqual({ ciudadanoId: expect.any(String), direccionUnica: expect.any(String) });
    expect(repo.markActive).toHaveBeenCalled();
  });

  describe("auditoria (HT-04)", () => {
    function makeAuditedService(overrides = {}) {
      const auditLogger = { record: jest.fn(async () => {}) };
      const service = new CitizenSagaService({
        citizenRepository: makeFakeRepo(),
        govCarpetaClient: makeFakeGovCarpeta(),
        eventPublisher: makeFakePublisher(),
        auditLogger,
        ...overrides,
      });
      return { service, auditLogger };
    }

    test("registra en bitacora un registro exitoso", async () => {
      const { service, auditLogger } = makeAuditedService();

      await service.register(validInput);

      expect(auditLogger.record).toHaveBeenCalledTimes(1);
      expect(auditLogger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "123",
          action: "ciudadano.registrar",
          resourceOwner: "123",
          outcome: "exito",
        })
      );
    });

    test("registra como 'rechazo' cuando el ciudadano ya esta afiliado", async () => {
      const { service, auditLogger } = makeAuditedService({
        govCarpetaClient: makeFakeGovCarpeta({ validateCitizen: jest.fn(async () => ({ available: false })) }),
      });

      await expect(service.register(validInput)).rejects.toThrow(ConflictError);

      expect(auditLogger.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "rechazo" }));
    });

    test("registra como 'fallo' cuando GovCarpeta no esta disponible", async () => {
      const { service, auditLogger } = makeAuditedService({
        govCarpetaClient: makeFakeGovCarpeta({
          validateCitizen: jest.fn(async () => {
            throw new Error("timeout");
          }),
        }),
      });

      await expect(service.register(validInput)).rejects.toThrow(ServiceUnavailableError);

      expect(auditLogger.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "fallo" }));
    });

    test("no audita entradas invalidas (todavia no hay actor identificable)", async () => {
      const { service, auditLogger } = makeAuditedService();

      await expect(service.register({ ...validInput, documento: "abc" })).rejects.toThrow(ValidationError);

      expect(auditLogger.record).not.toHaveBeenCalled();
    });

    test("un fallo al escribir la bitacora NO tumba el registro ya confirmado", async () => {
      const { service } = makeAuditedService({
        auditLogger: {
          record: jest.fn(async () => {
            throw new Error("mongo caido");
          }),
        },
      });

      const result = await service.register(validInput);

      expect(result).toEqual({ ciudadanoId: expect.any(String), direccionUnica: expect.any(String) });
    });
  });

  test("NO publica evento si la saga falla antes de llegar a activo", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta({ validateCitizen: jest.fn(async () => ({ available: false })) });
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await expect(service.register(validInput)).rejects.toThrow();
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
