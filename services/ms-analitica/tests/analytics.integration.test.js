/**
 * HU-07.1 (PASO 2) de extremo a extremo DENTRO de ms-analitica: GET /api/v1/analytics/summary.
 *
 * Cadena real: requireEntityAuth (401) -> controlador -> AnalyticsService (validacion minima) ->
 * DocumentsAnalyticsClient (reenvio del Authorization + from/to). SOLO se mockea el `http` (axios) que usa el
 * cliente -- todo lo demas (rutas, middleware, servicio) es codigo real, sin depender de un ms-documentos real.
 */
const request = require("supertest");
const buildApp = require("../src/app");
const SecretsManager = require("../src/security/SecretsManager");
const { DocumentsAnalyticsClient } = require("../src/infrastructure/DocumentsAnalyticsClient");
const { AnalyticsService } = require("../src/application/AnalyticsService");

const ENTITY_SECRET = "Rk3pL8bN2vXq6tZ4mC9sHd1jF7gW5yAu"; // 32 caracteres, solo de prueba
const entitySecrets = new SecretsManager({ active: ENTITY_SECRET });

const EAFIT = "6aae9153b7655900026073f1";
const PATH = "/api/v1/analytics/summary";

const SUMMARY_OK = {
  rango: { from: null, to: null },
  totalDocumentos: 128,
  porEstado: { temporal: 4, certificado: 124 },
  porMimeType: { "application/pdf": 125, "image/png": 3 },
  tamanoTotalBytes: 48213123,
  tamanoPromedioBytes: 376665,
  serieTemporal: [{ fecha: "2026-09-01", cantidad: 5 }],
};

const entityToken = (institutionId = EAFIT, options = {}) =>
  entitySecrets.sign({ typ: "access", act: "entidad", ver: true }, { issuer: "ms-comparticion", subject: institutionId, expiresIn: 900, ...options });

/** Construye la app con un DocumentsAnalyticsClient real, pero con un `http` (axios) FALSO inyectado. */
function buildAppWithFakeUpstream(getImpl) {
  const http = { get: jest.fn(getImpl) };
  const documentsAnalyticsClient = new DocumentsAnalyticsClient({ baseUrl: "http://ms-documentos:3002", timeoutMs: 5000, http });
  const analyticsService = new AnalyticsService({ documentsAnalyticsClient });
  const app = buildApp({ analyticsService, entitySecrets, entityIssuer: "ms-comparticion" });
  return { app, http };
}

const get = (app, token, query = "") => request(app).get(`${PATH}${query}`).set("Authorization", `Bearer ${token}`);

describe("Autenticacion", () => {
  test("401 sin token", async () => {
    const { app } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));
    await request(app).get(PATH).expect(401);
  });

  test("401 con token invalido (de ciudadano, expirado, o de otro emisor)", async () => {
    const { app, http } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));
    for (const token of [entityToken(EAFIT, { issuer: "ms-identidad" }), entityToken(EAFIT, { expiresIn: -10 })]) {
      await get(app, token).expect(401);
    }
    expect(http.get).not.toHaveBeenCalled(); // un token invalido nunca debe llegar hasta ms-documentos
  });

  test("200 con un token institucional valido", async () => {
    const { app } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));
    await get(app, entityToken()).expect(200);
  });
});

describe("Reenvio hacia ms-documentos", () => {
  test("reenvia el Authorization EXACTO recibido (no genera ni transforma ningun token)", async () => {
    const { app, http } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));
    const token = entityToken();

    await get(app, token).expect(200);

    expect(http.get).toHaveBeenCalledTimes(1);
    const [, config] = http.get.mock.calls[0];
    expect(config.headers.Authorization).toBe(`Bearer ${token}`);
  });

  test("reenvia from", async () => {
    const { app, http } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));

    await get(app, entityToken(), "?from=2026-01-01").expect(200);

    const [, config] = http.get.mock.calls[0];
    expect(config.params).toMatchObject({ from: "2026-01-01" });
    expect(config.params.to).toBeUndefined();
  });

  test("reenvia to", async () => {
    const { app, http } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));

    await get(app, entityToken(), "?to=2026-09-24").expect(200);

    const [, config] = http.get.mock.calls[0];
    expect(config.params).toMatchObject({ to: "2026-09-24" });
    expect(config.params.from).toBeUndefined();
  });

  test("llama exactamente a GET ${DOCUMENTOS_URL}/api/v1/documents/analytics/summary", async () => {
    const { app, http } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));
    await get(app, entityToken()).expect(200);
    const [url] = http.get.mock.calls[0];
    expect(url).toBe("http://ms-documentos:3002/api/v1/documents/analytics/summary");
  });

  test("un institutionId en el query se ignora: NUNCA se envia a ms-documentos ni cambia el resultado", async () => {
    const { app, http } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));

    const res = await get(app, entityToken(EAFIT), "?institutionId=6aae9153b7655900026073f2").expect(200);

    expect(res.body).toEqual(SUMMARY_OK);
    const [, config] = http.get.mock.calls[0];
    expect(config.params.institutionId).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("6aae9153b7655900026073f2");
  });
});

describe("Propagacion de errores", () => {
  test("un 400 de ms-documentos (fechas/rango) se propaga como 400", async () => {
    const { app } = buildAppWithFakeUpstream(async () => {
      const err = new Error("Request failed with status code 400");
      err.response = { status: 400, data: { error: "el rango entre from y to no puede superar 366 dias" } };
      throw err;
    });

    const res = await get(app, entityToken(), "?from=2020-01-01&to=2026-01-01");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("el rango entre from y to no puede superar 366 dias");
  });

  test("timeout de ms-documentos produce un error controlado (no 500, sin detalles internos)", async () => {
    const { app } = buildAppWithFakeUpstream(async () => {
      const err = new Error("timeout of 5000ms exceeded");
      err.code = "ECONNABORTED";
      throw err;
    });

    const res = await get(app, entityToken());

    expect(res.status).toBe(503);
    expect(res.body.error).not.toMatch(/ECONNABORTED|timeout of 5000ms|stack/i);
  });

  test("ms-documentos no disponible (conexion rechazada) produce un error controlado", async () => {
    const { app } = buildAppWithFakeUpstream(async () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:3002");
      err.code = "ECONNREFUSED";
      throw err;
    });

    const res = await get(app, entityToken());

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  test("un 500 inesperado de ms-documentos NO se propaga tal cual: se controla igual que un servicio no disponible", async () => {
    const { app } = buildAppWithFakeUpstream(async () => {
      const err = new Error("Request failed with status code 500");
      err.response = { status: 500, data: { error: "Error interno" } };
      throw err;
    });

    const res = await get(app, entityToken());

    expect(res.status).toBe(503);
  });

  test("NO hay reintentos: el cliente HTTP se llama exactamente una vez aunque falle", async () => {
    const { app, http } = buildAppWithFakeUpstream(async () => {
      throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
    });

    await get(app, entityToken());

    expect(http.get).toHaveBeenCalledTimes(1);
  });

  test("400 local (formato de from obviamente invalido) NUNCA llega a llamar a ms-documentos", async () => {
    const { app, http } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));

    const res = await get(app, entityToken(), "?from=no-es-una-fecha");

    expect(res.status).toBe(400);
    expect(http.get).not.toHaveBeenCalled();
  });
});

describe("Contrato de la respuesta", () => {
  test("mantiene EXACTAMENTE el contrato de HU-07.1 cuando ms-documentos responde bien", async () => {
    const { app } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));

    const res = await get(app, entityToken()).expect(200);

    expect(res.body).toEqual(SUMMARY_OK);
    expect(Object.keys(res.body).sort()).toEqual(["porEstado", "porMimeType", "rango", "serieTemporal", "tamanoPromedioBytes", "tamanoTotalBytes", "totalDocumentos"]);
  });

  test("no aparecen campos prohibidos (emisorInstitutionId, ciudadanoId, premium, plan, storageKey, etc.)", async () => {
    const { app } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));

    const res = await get(app, entityToken()).expect(200);

    const json = JSON.stringify(res.body);
    for (const prohibido of ["emisorInstitutionId", "ciudadanoId", "premium", "plan", "storageKey", "sha256", "titulo", "entidadAvaladora"]) {
      expect(json).not.toContain(prohibido);
    }
  });

  test("no se genera ningun JWT nuevo: el token de la respuesta (si lo hubiera) nunca aparece; solo se reenvia el original", async () => {
    const { app, http } = buildAppWithFakeUpstream(async () => ({ data: SUMMARY_OK }));
    const token = entityToken();

    await get(app, token).expect(200);

    const [, config] = http.get.mock.calls[0];
    // El unico Authorization que sale de ms-analitica es el mismo que entro -- nunca uno firmado de nuevo.
    expect(config.headers.Authorization).toBe(`Bearer ${token}`);
    expect(Object.keys(config.headers)).not.toContain("X-Service-Token");
  });
});
