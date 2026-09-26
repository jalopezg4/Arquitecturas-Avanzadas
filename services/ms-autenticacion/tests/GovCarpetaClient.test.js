const GovCarpetaClient = require("../src/infrastructure/GovCarpetaClient");
const { runWithTrace } = require("../src/tracing/TraceContext");

/** http falso: cada llamada devuelve la siguiente respuesta de la lista (o lanza si es un Error). */
function makeFakeHttp(responses) {
  const queue = [...responses];
  return {
    put: jest.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  };
}

const OK = { status: 200, data: "El documento: Diploma Grado del ciudadano 1000000001 ha sido autenticado exitosamente" };
const INPUT = { idCitizen: 1000000001, urlDocument: "https://storage.test/ciudadanos/a/b.pdf?X-Amz-Expires=900", documentTitle: "Diploma Grado" };

function client(responses, extra = {}) {
  const http = makeFakeHttp(responses);
  const sleep = jest.fn(async () => {});
  return { http, sleep, gc: new GovCarpetaClient({ baseUrl: "http://govcarpeta.test", http, sleep, baseDelayMs: 1000, ...extra }) };
}

describe("GovCarpetaClient.authenticateDocument()", () => {
  test("envia exactamente {idCitizen:number, UrlDocument (U mayuscula), documentTitle} al PUT correcto", async () => {
    const { http, gc } = client([OK]);

    await gc.authenticateDocument({ ...INPUT, idCitizen: "1000000001" });

    const [url, body, options] = http.put.mock.calls[0];
    expect(url).toBe("http://govcarpeta.test/apis/authenticateDocument");
    expect(body).toEqual({ idCitizen: 1000000001, UrlDocument: INPUT.urlDocument, documentTitle: "Diploma Grado" });
    expect(Object.keys(body)).not.toContain("urlDocument");
    expect(options.responseType).toBe("text");
  });

  test("nunca envia el binario: el cuerpo son solo tres campos de texto/numero", async () => {
    const { http, gc } = client([OK]);

    await gc.authenticateDocument(INPUT);

    const body = http.put.mock.calls[0][1];
    expect(Object.values(body).some((v) => Buffer.isBuffer(v))).toBe(false);
    expect(JSON.stringify(body).length).toBeLessThan(500);
  });

  test("200 con texto plano -> autenticado, conserva el mensaje tal cual", async () => {
    const { gc } = client([OK]);
    await expect(gc.authenticateDocument(INPUT)).resolves.toEqual({ status: 200, mensaje: OK.data, intentos: 1 });
  });

  test("reintenta ante 500 y fallas de red con espera creciente (1s, 2s) y confirma al tercer intento", async () => {
    const { http, sleep, gc } = client([{ status: 500 }, new Error("getaddrinfo ENOTFOUND"), OK]);

    await expect(gc.authenticateDocument(INPUT)).resolves.toMatchObject({ status: 200, intentos: 3 });

    expect(http.put).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  test("hasta 3 intentos como maximo: luego GOVCARPETA_UNAVAILABLE", async () => {
    const { http, gc } = client([{ status: 500 }, { status: 500 }, { status: 500 }, OK]);

    await expect(gc.authenticateDocument(INPUT)).rejects.toMatchObject({ code: "GOVCARPETA_UNAVAILABLE", intentos: 3 });
    expect(http.put).toHaveBeenCalledTimes(3);
  });

  test.each([[204], [501], [400], [404]])("%i es definitivo: no reintenta y no cuenta como autenticado", async (status) => {
    const { http, gc } = client([{ status }, OK]);

    await expect(gc.authenticateDocument(INPUT)).rejects.toMatchObject({ definitive: true, response: { status } });
    expect(http.put).toHaveBeenCalledTimes(1);
  });

  test("propaga el trace-id en el encabezado x-trace-id", async () => {
    const { http, gc } = client([OK]);

    await runWithTrace("trace-hu04-abcdef", () => gc.authenticateDocument(INPUT));

    expect(http.put.mock.calls[0][2].headers["x-trace-id"]).toBe("trace-hu04-abcdef");
  });
});
