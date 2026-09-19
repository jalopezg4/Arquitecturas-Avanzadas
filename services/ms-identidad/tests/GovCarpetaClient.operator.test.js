const GovCarpetaClient = require("../src/infrastructure/GovCarpetaClient");

const ID = "690d4e0e8502c8000221a5a7";
const data = { name: "Op", address: "Cra 1", contactMail: "a@a.com", participants: ["A", "B"] };

function clientWith(http) {
  return new GovCarpetaClient({ baseUrl: "http://gov", http });
}

describe("GovCarpetaClient.registerOperator()", () => {
  test("envia POST /apis/registerOperator con ambos juegos de nombres, contactMail y participants", async () => {
    const post = jest.fn(async () => ({ status: 201, data: ID }));

    await clientWith({ post }).registerOperator(data);

    expect(post).toHaveBeenCalledWith(
      "http://gov/apis/registerOperator",
      { name: "Op", nameOperator: "Op", address: "Cra 1", adress: "Cra 1", contactMail: "a@a.com", participants: ["A", "B"] },
      expect.anything()
    );
  });

  test.each([
    ["texto plano", ID],
    ["texto plano entre comillas", `"${ID}"`],
    ["con espacios y salto de linea", ` ${ID}\n`],
    ["objeto con _id", { _id: ID }],
    ["objeto con operatorId", { operatorId: ID }],
  ])("extrae el operatorId de una respuesta 201 (%s)", async (_label, body) => {
    const client = clientWith({ post: async () => ({ status: 201, data: body }) });
    await expect(client.registerOperator(data)).resolves.toEqual({ operatorId: ID });
  });

  test("un 201 sin id utilizable se distingue (el operador pudo crearse) y no devuelve basura", async () => {
    for (const body of ["", null, {}, "<html>error</html>", "ok"]) {
      const client = clientWith({ post: async () => ({ status: 201, data: body }) });
      await expect(client.registerOperator(data)).rejects.toMatchObject({ code: "OPERATOR_CREATED_WITHOUT_ID" });
    }
  });

  test("solo 201 es exito: 200, 204, 501 y 500 lanzan error", async () => {
    for (const status of [200, 204, 500, 501]) {
      const client = clientWith({ post: async () => ({ status, data: ID }) });
      await expect(client.registerOperator(data)).rejects.toThrow(String(status));
    }
  });

  test("NO se reintenta (crearia operadores duplicados en un directorio sin borrado)", async () => {
    const post = jest.fn(async () => ({ status: 500, data: "" }));

    await expect(clientWith({ post }).registerOperator(data)).rejects.toThrow();

    expect(post).toHaveBeenCalledTimes(1);
  });

  test("un error de red (sin respuesta) se propaga y tampoco se reintenta", async () => {
    const post = jest.fn(async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    await expect(clientWith({ post }).registerOperator(data)).rejects.toThrow("socket hang up");
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("GovCarpetaClient.listOperators()", () => {
  test("normaliza la forma REAL del sandbox (_id, operatorName) -- distinta de la del Swagger", async () => {
    const real = [{ _id: ID, operatorName: "Carpeta Ciudadana", participants: ["x"], transferAPIURL: " http://t.com/api/transferCitizen" }];
    const list = await clientWith({ get: async () => ({ data: real }) }).listOperators();

    expect(list).toEqual([{ id: ID, name: "Carpeta Ciudadana", transferApiUrl: "http://t.com/api/transferCitizen", participants: ["x"] }]);
  });

  test("tambien acepta la forma del Swagger (OperatorId / OperatorName) y variantes de casing", async () => {
    const swagger = [{ OperatorId: "65ca0a00d833e984e2608756", OperatorName: "Op A" }, { operatorId: "65ca0a00d833e984e2608758", operatorName: "Op B" }];
    const list = await clientWith({ get: async () => ({ data: swagger }) }).listOperators();

    expect(list.map((o) => [o.id, o.name])).toEqual([["65ca0a00d833e984e2608756", "Op A"], ["65ca0a00d833e984e2608758", "Op B"]]);
  });

  test("descarta entradas sin id y deja transferApiUrl en null cuando falta o esta vacia (55 de 71 reales no la tienen)", async () => {
    const list = await clientWith({ get: async () => ({ data: [{ operatorName: "sin id" }, { _id: ID, operatorName: "A", transferAPIURL: "  " }, { _id: "690d4e0e8502c8000221a5a8", operatorName: "B" }] }) }).listOperators();

    expect(list).toHaveLength(2);
    expect(list.every((o) => o.transferApiUrl === null)).toBe(true);
  });

  test("falla si la respuesta no es una lista", async () => {
    await expect(clientWith({ get: async () => ({ data: { error: "x" } }) }).listOperators()).rejects.toThrow("lista");
  });

  test("es idempotente, asi que SI reintenta ante 500", async () => {
    let calls = 0;
    const get = jest.fn(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("boom"), { response: { status: 500 } });
      return { data: [{ _id: ID, operatorName: "A" }] };
    });

    const list = await clientWith({ get }).listOperators();

    expect(list).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(3);
  });
});
