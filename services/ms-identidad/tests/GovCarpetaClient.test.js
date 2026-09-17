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

  test("validateCitizen() NO reintenta ante 501 (error de negocio segun el Swagger, no transitorio)", async () => {
    const get = jest.fn(async () => {
      const err = new Error("wrong parameters");
      err.response = { status: 501 };
      throw err;
    });
    const client = new GovCarpetaClient({
      baseUrl: "http://fake",
      operatorId: "op1",
      operatorName: "Op",
      maxRetries: 3,
      http: makeFakeHttp({ getImpl: get }),
    });

    await expect(client.validateCitizen(123)).rejects.toThrow("wrong parameters");
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("validateCitizen() usa availableStatus configurable para interpretar 200/204", async () => {
    const get = jest.fn(async () => ({ status: 204 }));
    const client = new GovCarpetaClient({
      baseUrl: "http://fake",
      operatorId: "op1",
      operatorName: "Op",
      availableStatus: 204, // invertido respecto al default (200), simulando verificacion empirica distinta
      http: makeFakeHttp({ getImpl: get }),
    });

    const result = await client.validateCitizen(123);
    expect(result).toEqual({ available: true });
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
      expect.objectContaining({ id: 999, operatorId: "op-123", operatorName: "Mi Operador" }),
      expect.anything()
    );
  });

  test("registerCitizen() lanza error si el status no es exactamente 201", async () => {
    const post = jest.fn(async () => ({ status: 200 })); // 2xx pero no 201
    const client = new GovCarpetaClient({
      baseUrl: "http://fake",
      operatorId: "op-123",
      operatorName: "Mi Operador",
      http: makeFakeHttp({ postImpl: post }),
    });

    await expect(client.registerCitizen({ id: 999, name: "Ana", address: "Calle 1", email: "a@a.com" })).rejects.toThrow(
      "201"
    );
  });

  test("registerCitizen() NO reintenta (no es idempotente): una sola llamada aunque falle con 500", async () => {
    const post = jest.fn(async () => ({ status: 500 }));
    const client = new GovCarpetaClient({
      baseUrl: "http://fake",
      operatorId: "op-123",
      operatorName: "Mi Operador",
      maxRetries: 3,
      http: makeFakeHttp({ postImpl: post }),
    });

    await expect(client.registerCitizen({ id: 999, name: "Ana", address: "Calle 1", email: "a@a.com" })).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
