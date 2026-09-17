const GovCarpetaClient = require("../src/infrastructure/GovCarpetaClient");

function makeFakeHttp({ getImpl, postImpl } = {}) {
  return {
    get: getImpl || jest.fn(async () => ({ status: 200 })),
    post: postImpl || jest.fn(async () => ({ status: 201 })),
    delete: jest.fn(async () => ({ status: 201 })),
  };
}

describe("GovCarpetaClient", () => {
  test("validateCitizen() reintenta con backoff ante 500, maximo 3 veces", async () => {
    let calls = 0;
    const get = jest.fn(async () => {
      calls += 1;
      const err = new Error("fail");
      err.response = { status: 500 };
      throw err;
    });
    const client = new GovCarpetaClient({
      baseUrl: "http://fake",
      operatorId: "op1",
      operatorName: "Op",
      maxRetries: 3,
      http: makeFakeHttp({ getImpl: get }),
    });

    await expect(client.validateCitizen(123)).rejects.toThrow();
    expect(calls).toBe(3);
  });

  test("validateCitizen() responde con error GOVCARPETA_UNAVAILABLE tras agotar reintentos", async () => {
    const get = jest.fn(async () => {
      const err = new Error("fail");
      err.response = { status: 500 };
      throw err;
    });
    const client = new GovCarpetaClient({
      baseUrl: "http://fake",
      operatorId: "op1",
      operatorName: "Op",
      maxRetries: 2,
      http: makeFakeHttp({ getImpl: get }),
    });

    await expect(client.validateCitizen(123)).rejects.toMatchObject({ code: "GOVCARPETA_UNAVAILABLE" });
  });

  test("validateCitizen() NO reintenta ante errores de negocio (4xx)", async () => {
    const get = jest.fn(async () => {
      const err = new Error("bad request");
      err.response = { status: 400 };
      throw err;
    });
    const client = new GovCarpetaClient({
      baseUrl: "http://fake",
      operatorId: "op1",
      operatorName: "Op",
      maxRetries: 3,
      http: makeFakeHttp({ getImpl: get }),
    });

    await expect(client.validateCitizen(123)).rejects.toThrow("bad request");
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("registerCitizen() envia operatorId/operatorName propios junto con los datos del ciudadano", async () => {
    const post = jest.fn(async () => ({ status: 201 }));
    const client = new GovCarpetaClient({
      baseUrl: "http://fake",
      operatorId: "op-123",
      operatorName: "Mi Operador",
      http: makeFakeHttp({ postImpl: post }),
    });

    await client.registerCitizen({ id: 999, name: "Ana", address: "Calle 1", email: "a@a.com" });

    expect(post).toHaveBeenCalledWith(
      "http://fake/apis/registerCitizen",
      expect.objectContaining({ id: 999, operatorId: "op-123", operatorName: "Mi Operador" })
    );
  });
});
