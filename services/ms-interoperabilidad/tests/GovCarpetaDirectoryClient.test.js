const { GovCarpetaDirectoryClient, normalizeOperator } = require("../src/infrastructure/GovCarpetaDirectoryClient");
const { runWithTrace } = require("../src/tracing/TraceContext");

const ID = "690d4e0e8502c8000221a5a7";
const clientWith = (http, options = {}) => new GovCarpetaDirectoryClient({ baseUrl: "http://gov", http, baseDelayMs: 1, ...options });
const ok = (data) => ({ get: jest.fn(async () => ({ status: 200, data })) });

describe("normalizacion: el sandbox REAL no coincide con el Swagger (mayusculas/minusculas)", () => {
  const expected = { id: ID, name: "Carpeta Ciudadana", transferApiUrl: "http://t.co/api/transferCitizen", participants: [] };

  test.each([
    ["forma REAL del sandbox (_id, operatorName)", { _id: ID, operatorName: "Carpeta Ciudadana", transferAPIURL: "http://t.co/api/transferCitizen" }],
    ["forma del SWAGGER (OperatorId, OperatorName)", { OperatorId: ID, OperatorName: "Carpeta Ciudadana", transferAPIURL: "http://t.co/api/transferCitizen" }],
    ["forma de registerCitizen (operatorId, operatorName)", { operatorId: ID, operatorName: "Carpeta Ciudadana", transferAPIURL: "http://t.co/api/transferCitizen" }],
    ["id generico y name", { id: ID, name: "Carpeta Ciudadana", transferAPIURL: "http://t.co/api/transferCitizen" }],
    ["URL con la mayuscula cambiada", { _id: ID, operatorName: "Carpeta Ciudadana", TransferAPIURL: "http://t.co/api/transferCitizen" }],
    ["URL en camelCase", { _id: ID, operatorName: "Carpeta Ciudadana", transferApiUrl: "http://t.co/api/transferCitizen" }],
  ])("%s produce el MISMO operador", (_name, raw) => {
    expect(normalizeOperator(raw)).toEqual(expected);
  });

  test("un typo de mayusculas ya NO rompe la localizacion en silencio: las tres formas del mismo operador dan el mismo id y nombre", async () => {
    const list = await clientWith(ok([{ _id: ID, operatorName: "A" }, { OperatorId: "65ca0a00d833e984e2608756", OperatorName: "B" }, { operatorId: "65ca0a00d833e984e2608758", operatorName: "C" }])).listOperators();
    expect(list.map((o) => [o.id, o.name])).toEqual([[ID, "A"], ["65ca0a00d833e984e2608756", "B"], ["65ca0a00d833e984e2608758", "C"]]);
  });

  test("la URL real viene con un ESPACIO inicial en algunos operadores: se recorta", () => {
    expect(normalizeOperator({ _id: ID, operatorName: "X", transferAPIURL: " http://t.co/api/transferCitizen" }).transferApiUrl).toBe("http://t.co/api/transferCitizen");
  });

  test("sin URL (55 de 71 reales), vacia o solo espacios -> null", () => {
    for (const transferAPIURL of [undefined, "", "   ", null, 42]) expect(normalizeOperator({ _id: ID, operatorName: "X", transferAPIURL }).transferApiUrl).toBeNull();
  });
});

describe("respuestas hostiles o mal formadas", () => {
  test("descarta entradas sin id valido o sin nombre, y no acepta ids con caracteres de ruta", async () => {
    const list = await clientWith(ok([null, "texto", 7, {}, { _id: ID }, { _id: "../x", operatorName: "mal" }, { _id: "a/b", operatorName: "mal" }, { _id: {}, operatorName: "x" }, { _id: ID, operatorName: "  " }, { _id: ID, operatorName: "Valido" }])).listOperators();
    expect(list).toEqual([{ id: ID, name: "Valido", transferApiUrl: null, participants: [] }]);
  });

  test("ids repetidos: se conserva el primero", async () => {
    const list = await clientWith(ok([{ _id: ID, operatorName: "Primero" }, { _id: ID, operatorName: "Segundo" }])).listOperators();
    expect(list).toEqual([expect.objectContaining({ name: "Primero" })]);
  });

  test("nombres y participantes acotados; sin caracteres de control", () => {
    const op = normalizeOperator({ _id: ID, operatorName: `Nombre\r\nBcc: x${"y".repeat(300)}`, participants: ["Ana", 5, null, "Beto\n", ...Array.from({ length: 40 }, (_, i) => `P${i}`)] });
    expect(op.name).not.toMatch(/[\r\n]/);
    expect(op.name.length).toBeLessThanOrEqual(200);
    expect(op.participants).toHaveLength(20);
    expect(op.participants.slice(0, 2)).toEqual(["Ana", "Beto"]);
  });

  test("una URL absurdamente larga se descarta (queda como si no hubiera publicado)", () => {
    expect(normalizeOperator({ _id: ID, operatorName: "X", transferAPIURL: `http://a.co/${"x".repeat(3000)}` }).transferApiUrl).toBeNull();
  });

  test("una respuesta que no es una lista falla SIN reintentar (reintentar no la arregla)", async () => {
    const http = ok({ error: "x" });
    await expect(clientWith(http).listOperators()).rejects.toThrow("lista");
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  test("una lista desmesurada (mas de 5000) se rechaza: no se carga en memoria ni en la base", async () => {
    const http = ok(Array.from({ length: 5001 }, (_, i) => ({ _id: `id${String(i).padStart(10, "0")}`, operatorName: `Op ${i}` })));
    await expect(clientWith(http).listOperators()).rejects.toThrow("demasiados operadores");
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  test("el cliente HTTP real limita el tamano de la respuesta y el tiempo de espera", () => {
    const { http } = new GovCarpetaDirectoryClient({ baseUrl: "http://gov", timeoutMs: 1234 });
    expect(http.defaults.timeout).toBe(1234);
    expect(http.defaults.maxContentLength).toBe(5 * 1024 * 1024);
  });
});

describe("reintentos (getOperators es idempotente)", () => {
  test("reintenta ante 500 y ante fallas de red, y termina bien", async () => {
    let calls = 0;
    const http = {
      get: jest.fn(async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("boom"), { response: { status: 500 } });
        if (calls === 2) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        return { data: [{ _id: ID, operatorName: "A" }] };
      }),
    };

    const list = await clientWith(http).listOperators();

    expect(list).toHaveLength(1);
    expect(http.get).toHaveBeenCalledTimes(3);
  });

  test.each([400, 404, 501])("NO reintenta un %s (error definitivo)", async (status) => {
    const http = { get: jest.fn(async () => { throw Object.assign(new Error("x"), { response: { status } }); }) };
    await expect(clientWith(http).listOperators()).rejects.toThrow();
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  test("agotados los reintentos -> GOVCARPETA_UNAVAILABLE, con la causa", async () => {
    const http = { get: jest.fn(async () => { throw Object.assign(new Error("boom"), { response: { status: 500 } }); }) };
    const err = await clientWith(http, { maxRetries: 3 }).listOperators().catch((e) => e);
    expect(err.code).toBe("GOVCARPETA_UNAVAILABLE");
    expect(err.cause.message).toBe("boom");
    expect(http.get).toHaveBeenCalledTimes(3);
  });

  test("reenvia el trace-id a GovCarpeta (HT-06)", async () => {
    const http = ok([]);
    await runWithTrace("traza-directorio-01", () => clientWith(http).listOperators());
    expect(http.get).toHaveBeenCalledWith("http://gov/apis/getOperators", { headers: { "x-trace-id": "traza-directorio-01" } });
  });
});
