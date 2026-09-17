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

  test("NO publica evento si la saga falla antes de llegar a activo", async () => {
    const repo = makeFakeRepo();
    const gov = makeFakeGovCarpeta({ validateCitizen: jest.fn(async () => ({ available: false })) });
    const publisher = makeFakePublisher();
    const service = new CitizenSagaService({ citizenRepository: repo, govCarpetaClient: gov, eventPublisher: publisher });

    await expect(service.register(validInput)).rejects.toThrow();
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
