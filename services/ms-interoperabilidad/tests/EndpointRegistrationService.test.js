const {
  EndpointRegistrationService,
  EndpointInputError,
  OperatorNotRegisteredError,
  AlreadyPublishedError,
  PublicationError,
} = require("../src/application/EndpointRegistrationService");
const GovCarpetaEndpointClient = require("../src/infrastructure/GovCarpetaEndpointClient");

const OWN = "6aae9153b7655900026073f1";
const op = (id, name, transferApiUrl = null) => ({ id, name, transferApiUrl, participants: [] });
const BASE = "https://mifolio.operadores.co";
const EXPECTED = { idOperator: OWN, endPoint: `${BASE}/api/transferCitizen`, endPointConfirm: `${BASE}/api/transferCitizenConfirm` };

let directory;
let directoryClient;
let endpointClient;

beforeEach(() => {
  directory = [op("690d4e0e8502c8000221a5a7", "Carpeta Ciudadana", "http://carpeta.operadores.co/api/transferCitizen"), op(OWN, "MiFolio")];
  directoryClient = { listOperators: jest.fn(async () => directory.map((o) => ({ ...o }))) };
  endpointClient = { registerTransferEndPoint: jest.fn(async () => ({ status: 201 })) };
});

const service = (urlPolicy) => new EndpointRegistrationService({ directoryClient, endpointClient, urlPolicy });
const publish = (input = {}, options) => service().publish({ operatorId: OWN, baseUrl: BASE, ...input }, options);

describe("EndpointRegistrationService.publish() -- requiere operatorId existente (HU-11)", () => {
  test("sin OPERATOR_ID falla explicando que hay que registrar el operador primero, sin consultar ni enviar nada", async () => {
    const err = await publish({ operatorId: undefined }).catch((e) => e);

    expect(err).toBeInstanceOf(OperatorNotRegisteredError);
    expect(err.message).toMatch(/HU-11/);
    expect(directoryClient.listOperators).not.toHaveBeenCalled();
    expect(endpointClient.registerTransferEndPoint).not.toHaveBeenCalled();
  });

  test("un operatorId que NO existe en el directorio de GovCarpeta -> OperatorNotRegisteredError y no se publica", async () => {
    await expect(publish({ operatorId: "ffffffffffffffffffffffff" })).rejects.toThrow(OperatorNotRegisteredError);
    expect(endpointClient.registerTransferEndPoint).not.toHaveBeenCalled();
  });

  test.each(["../x", "corto", "a b c d e f g h", 42])("un OPERATOR_ID con formato invalido (%j) se rechaza antes de todo", async (bad) => {
    await expect(publish({ operatorId: bad })).rejects.toThrow(EndpointInputError);
    expect(directoryClient.listOperators).not.toHaveBeenCalled();
  });
});

describe("EndpointRegistrationService.publish() -- falla si ya esta publicado", () => {
  test("si nuestro operador YA tiene direccion publicada, falla con mensaje claro y NO envia nada", async () => {
    directory.find((o) => o.id === OWN).transferApiUrl = "https://viejo.operadores.co/api/transferCitizen";

    const err = await publish().catch((e) => e);

    expect(err).toBeInstanceOf(AlreadyPublishedError);
    expect(err.current).toBe("https://viejo.operadores.co/api/transferCitizen");
    expect(err.same).toBe(false);
    expect(err.message).toMatch(/ya tiene una direccion de transferencia publicada/);
    expect(err.message).toMatch(/--replace/);
    expect(endpointClient.registerTransferEndPoint).not.toHaveBeenCalled();
  });

  test("tambien falla si es LA MISMA direccion (no la 'duplica'), y lo dice", async () => {
    directory.find((o) => o.id === OWN).transferApiUrl = " HTTPS://MiFolio.operadores.co/api/transferCitizen"; // casing y espacio como en el sandbox real

    const err = await publish().catch((e) => e);

    expect(err).toBeInstanceOf(AlreadyPublishedError);
    expect(err.same).toBe(true);
    expect(err.message).toMatch(/misma que se iba a publicar/);
  });

  test("con replace (decision explicita) SI reemplaza la direccion publicada", async () => {
    directory.find((o) => o.id === OWN).transferApiUrl = "https://viejo.operadores.co/api/transferCitizen";

    const res = await publish({}, { replace: true });

    expect(res.status).toBe("published");
    expect(endpointClient.registerTransferEndPoint).toHaveBeenCalledWith(EXPECTED);
  });

  test("la direccion de OTRO operador no cuenta: solo importa la nuestra", async () => {
    // "Carpeta Ciudadana" ya tiene direccion (directorio de arriba); nosotros no
    await expect(publish()).resolves.toMatchObject({ status: "published" });
  });
});

describe("Publicacion exitosa", () => {
  test("envia {idOperator, endPoint, endPointConfirm} (nombres verificados contra el Swagger real, NO operatorId/transferEndpoint)", async () => {
    await publish();

    expect(endpointClient.registerTransferEndPoint).toHaveBeenCalledTimes(1);
    expect(endpointClient.registerTransferEndPoint).toHaveBeenCalledWith(EXPECTED);
    const sent = endpointClient.registerTransferEndPoint.mock.calls[0][0];
    expect(Object.keys(sent).sort()).toEqual(["endPoint", "endPointConfirm", "idOperator"]);
    expect(sent).not.toHaveProperty("operatorId");
    expect(sent).not.toHaveProperty("transferEndpoint");
  });

  test("publica SIEMPRE endPointConfirm (indispensable para el protocolo de dos fases, aunque el Swagger no lo exija)", async () => {
    await publish();
    expect(endpointClient.registerTransferEndPoint.mock.calls[0][0].endPointConfirm).toBe(`${BASE}/api/transferCitizenConfirm`);
  });

  test("se puede dar la base con o sin barra final, o las dos direcciones por separado", async () => {
    await publish({ baseUrl: `${BASE}///` });
    expect(endpointClient.registerTransferEndPoint.mock.calls[0][0].endPoint).toBe(`${BASE}/api/transferCitizen`);

    endpointClient.registerTransferEndPoint.mockClear();
    await publish({ baseUrl: undefined, endPoint: "https://otro.co/recibir", endPointConfirm: "https://otro.co/confirmar" });
    expect(endpointClient.registerTransferEndPoint).toHaveBeenCalledWith({ idOperator: OWN, endPoint: "https://otro.co/recibir", endPointConfirm: "https://otro.co/confirmar" });
  });

  test("despues de publicar VERIFICA en el directorio: verified=true cuando ya lo refleja", async () => {
    endpointClient.registerTransferEndPoint.mockImplementation(async () => {
      directory.find((o) => o.id === OWN).transferApiUrl = EXPECTED.endPoint;
      return { status: 201 };
    });

    const res = await publish();

    expect(res).toMatchObject({ status: "published", verified: true, payload: EXPECTED });
    expect(directoryClient.listOperators).toHaveBeenCalledTimes(2); // antes y despues
  });

  test("si GovCarpeta acepta pero el directorio aun no lo refleja, NO falla: verified=false (demora del sandbox)", async () => {
    const res = await publish();
    expect(res).toMatchObject({ status: "published", verified: false });
  });

  test("si la verificacion posterior no se puede consultar, tampoco falla", async () => {
    directoryClient.listOperators.mockResolvedValueOnce(directory).mockRejectedValueOnce(new Error("timeout"));
    await expect(publish()).resolves.toMatchObject({ status: "published", verified: false });
  });
});

describe("Simulacion (dryRun): valida y consulta, pero NO envia", () => {
  test("devuelve lo que enviaria y no llama a registerTransferEndPoint", async () => {
    const res = await publish({}, { dryRun: true });

    expect(res).toEqual({ status: "dry-run", payload: EXPECTED, replacing: false });
    expect(directoryClient.listOperators).toHaveBeenCalledTimes(1);
    expect(endpointClient.registerTransferEndPoint).not.toHaveBeenCalled();
  });

  test("tambien falla si ya esta publicado (asi la simulacion avisa antes de confirmar)", async () => {
    directory.find((o) => o.id === OWN).transferApiUrl = "https://viejo.operadores.co/t";
    await expect(publish({}, { dryRun: true })).rejects.toThrow(AlreadyPublishedError);
  });

  test("con replace avisa que REEMPLAZARIA la direccion actual", async () => {
    directory.find((o) => o.id === OWN).transferApiUrl = "https://viejo.operadores.co/t";
    await expect(publish({}, { dryRun: true, replace: true })).resolves.toMatchObject({ status: "dry-run", replacing: true });
  });
});

describe("Las direcciones que ven OTROS operadores no pueden ser internas", () => {
  test.each([
    ["localhost", { baseUrl: "http://localhost:3004" }],
    ["IP privada", { baseUrl: "http://192.168.1.20" }],
    ["metadatos de la nube", { baseUrl: "http://169.254.169.254" }],
    ["esquema file", { baseUrl: "file:///etc" }],
    ["credenciales en la URL", { baseUrl: "https://admin:secreto@mifolio.co" }],
    ["host interno de Docker", { baseUrl: "http://ms-interoperabilidad:3004" }],
  ])("%s -> EndpointInputError y no se consulta ni se envia nada", async (_name, override) => {
    await expect(publish(override)).rejects.toThrow(EndpointInputError);
    expect(endpointClient.registerTransferEndPoint).not.toHaveBeenCalled();
    expect(directoryClient.listOperators).not.toHaveBeenCalled();
  });

  test("informa TODOS los problemas a la vez, indicando cual direccion", async () => {
    const err = await publish({ baseUrl: undefined, endPoint: "http://localhost/a", endPointConfirm: "http://10.0.0.1/b" }).catch((e) => e);
    expect(err.problems).toHaveLength(2);
    expect(err.problems.join()).toMatch(/endPoint:.*endPointConfirm:/);
  });

  test("sin PUBLIC_BASE_URL ni las dos direcciones explicitas -> explica que falta", async () => {
    const err = await publish({ baseUrl: undefined }).catch((e) => e);
    expect(err.message).toMatch(/PUBLIC_BASE_URL/);
  });

  test("endPoint y endPointConfirm no pueden ser la misma direccion", async () => {
    await expect(publish({ baseUrl: undefined, endPoint: "https://x.co/t", endPointConfirm: "https://x.co/t" })).rejects.toThrow(/distintas/);
  });

  test("en desarrollo local, allowPrivate permite publicar hacia localhost", async () => {
    const res = await service({ allowPrivate: true }).publish({ operatorId: OWN, baseUrl: "http://localhost:3004" }, { dryRun: true });
    expect(res.payload.endPoint).toBe("http://localhost:3004/api/transferCitizen");
  });
});

describe("Fallos de GovCarpeta", () => {
  test("si no se puede consultar el directorio, NO se publica (no se puede saber si ya estaba publicado)", async () => {
    directoryClient.listOperators.mockRejectedValue(new Error("timeout"));

    await expect(publish()).rejects.toThrow(/no se publico nada/);
    expect(endpointClient.registerTransferEndPoint).not.toHaveBeenCalled();
  });

  test("501 (definitivo): falla claro diciendo que no se cambio nada, sin releer el directorio", async () => {
    endpointClient.registerTransferEndPoint.mockRejectedValue(Object.assign(new Error("501"), { definitive: true, response: { status: 501 } }));

    const err = await publish().catch((e) => e);

    expect(err).toBeInstanceOf(PublicationError);
    expect(err.message).toMatch(/rechazo la publicacion \(501\).*No se cambio nada/);
    expect(directoryClient.listOperators).toHaveBeenCalledTimes(1); // solo la comprobacion previa
  });

  test("respuesta PERDIDA pero la publicacion SI se aplico: se detecta releyendo el directorio (no se da por fallida)", async () => {
    endpointClient.registerTransferEndPoint.mockImplementation(async () => {
      directory.find((o) => o.id === OWN).transferApiUrl = EXPECTED.endPoint; // se aplico...
      throw Object.assign(new Error("socket hang up"), { code: "GOVCARPETA_UNAVAILABLE" }); // ...pero la respuesta no llego
    });

    const res = await publish();

    expect(res).toMatchObject({ status: "recovered", verified: true });
  });

  test("respuesta perdida y NO se aplico: error que manda a revisar el directorio antes de reintentar", async () => {
    endpointClient.registerTransferEndPoint.mockRejectedValue(Object.assign(new Error("sin respuesta"), { code: "GOVCARPETA_UNAVAILABLE" }));

    const err = await publish().catch((e) => e);

    expect(err).toBeInstanceOf(PublicationError);
    expect(err.message).toMatch(/No se pudo confirmar/);
  });
});

describe("GovCarpetaEndpointClient.registerTransferEndPoint()", () => {
  const clientWith = (http, options) => new GovCarpetaEndpointClient({ baseUrl: "http://gov", http, baseDelayMs: 1, ...options });
  const body = { idOperator: OWN, endPoint: "https://x.co/t", endPointConfirm: "https://x.co/c" };

  test("hace PUT /apis/registerTransferEndPoint con el cuerpo exacto y acepta 201 (y 200)", async () => {
    for (const status of [201, 200]) {
      const put = jest.fn(async () => ({ status, data: "Updated" }));
      await expect(clientWith({ put }).registerTransferEndPoint(body)).resolves.toEqual({ status });
      expect(put).toHaveBeenCalledWith("http://gov/apis/registerTransferEndPoint", body, expect.objectContaining({ headers: expect.any(Object) }));
    }
  });

  test("solo envia los tres campos del contrato, aunque le pasen otros", async () => {
    const put = jest.fn(async () => ({ status: 201 }));
    await clientWith({ put }).registerTransferEndPoint({ ...body, operatorId: "x", extra: "y" });
    expect(put.mock.calls[0][1]).toEqual(body);
  });

  test("reintenta ante 500 y fallas de red (es una ACTUALIZACION idempotente) y termina bien", async () => {
    let calls = 0;
    const put = jest.fn(async () => {
      calls += 1;
      if (calls === 1) return { status: 500 };
      if (calls === 2) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
      return { status: 201 };
    });

    await expect(clientWith({ put }).registerTransferEndPoint(body)).resolves.toEqual({ status: 201 });
    expect(put).toHaveBeenCalledTimes(3);
  });

  test.each([400, 404, 501])("un %s es definitivo: NO se reintenta", async (status) => {
    const put = jest.fn(async () => ({ status, data: "failed : Wrong Parameters.." }));
    const err = await clientWith({ put }).registerTransferEndPoint(body).catch((e) => e);
    expect(err.definitive).toBe(true);
    expect(err.response.status).toBe(status);
    expect(put).toHaveBeenCalledTimes(1);
  });

  test("agotados los reintentos -> GOVCARPETA_UNAVAILABLE", async () => {
    const put = jest.fn(async () => ({ status: 500 }));
    const err = await clientWith({ put }).registerTransferEndPoint(body).catch((e) => e);
    expect(err.code).toBe("GOVCARPETA_UNAVAILABLE");
    expect(put).toHaveBeenCalledTimes(3);
  });
});
