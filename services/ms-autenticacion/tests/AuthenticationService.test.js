/**
 * HU-04, ola 4: procesamiento de `documento.autenticacion_solicitada` en ms-autenticacion, contra Mongo en memoria y
 * con GovCarpeta, storage y broker falsos.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AuthenticationAttempt = require("../src/domain/AuthenticationAttempt");
const AuditEntry = require("../src/domain/AuditEntry");
const AttemptRepository = require("../src/infrastructure/AttemptRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { PresignedUrlService } = require("../src/application/PresignedUrlService");
const { AuthenticationService } = require("../src/application/AuthenticationService");
const { makeEventHandlers, parseSolicitud } = require("../src/interfaces/eventHandlers");
const logger = require("../src/tracing/logger");

const ANA = "6aae9153b7655900026073f1";
const DOC = "6ab68fddb64d2aa730b415bb";
const NOW = new Date("2026-09-26T15:00:00Z");
const SOLICITUD = {
  eventId: `${DOC}-auth-1`,
  documentoId: DOC,
  ciudadanoId: ANA,
  documento: 1000000001,
  titulo: "Diploma de grado",
  storageKey: `ciudadanos/${ANA}/3f9c2ab7-1111-4222-8333-444455556666.pdf`,
  intento: 1,
  solicitadaEn: NOW.toISOString(),
};
const URL_FIRMADA = "https://files.example.net/carpeta-documentos/x.pdf?X-Amz-Expires=900&X-Amz-Signature=abc";

let mongoServer;
beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
afterEach(async () => {
  logger.resetSink();
  await mongoose.connection.dropDatabase();
});

let govCarpeta;
let publisher;
let storage;
let service;
let handlers;

function build({ govImpl, publishImpl } = {}) {
  govCarpeta = { authenticateDocument: jest.fn(govImpl || (async () => ({ status: 200, mensaje: "ok", intentos: 1 }))) };
  publisher = { publish: jest.fn(publishImpl || (async () => {})) };
  storage = { presignedGetUrl: jest.fn(async () => URL_FIRMADA) };
  service = new AuthenticationService({
    attemptRepository: new AttemptRepository(),
    presignedUrlService: new PresignedUrlService({ storage, ttlSeconds: 900 }),
    govCarpetaClient: govCarpeta,
    eventPublisher: publisher,
    auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
    eventPublishTimeoutMs: 200,
    now: () => NOW,
  });
  handlers = makeEventHandlers({ authenticationService: service });
}
beforeEach(async () => {
  await AuthenticationAttempt.init();
  build();
});

const definitivo = (status) => Object.assign(new Error(`respondio ${status}`), { definitive: true, intentos: 1, response: { status } });
const agotado = () => Object.assign(new Error("sin respuesta"), { code: "GOVCARPETA_UNAVAILABLE", intentos: 3 });

describe("Autenticacion exitosa", () => {
  test("firma una URL de 15 min, llama a GovCarpeta con cedula + URL + titulo y publica documento.autenticado", async () => {
    await handlers.autenticacionSolicitada(SOLICITUD);

    expect(storage.presignedGetUrl).toHaveBeenCalledWith(SOLICITUD.storageKey, 900);
    expect(govCarpeta.authenticateDocument).toHaveBeenCalledWith({ idCitizen: 1000000001, urlDocument: URL_FIRMADA, documentTitle: "Diploma de grado" });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith("documento.autenticado", {
      eventId: `${DOC}-auth-1-ok`,
      documentoId: DOC,
      ciudadanoId: ANA,
      titulo: "Diploma de grado",
      intento: 1,
      autenticadoEn: NOW.toISOString(),
    });
    expect(await AuthenticationAttempt.findOne({ eventId: SOLICITUD.eventId }).lean()).toMatchObject({ estado: "autenticado", resultadoPublicado: true });
  });

  test("el evento de resultado no lleva la URL firmada ni la cedula", async () => {
    await handlers.autenticacionSolicitada(SOLICITUD);

    const payload = JSON.stringify(publisher.publish.mock.calls[0][1]);
    expect(payload).not.toContain("X-Amz");
    expect(payload).not.toContain("1000000001");
  });

  test("queda en la bitacora como accion del sistema, delegada por el ciudadano", async () => {
    await handlers.autenticacionSolicitada(SOLICITUD);

    expect(await AuditEntry.findOne({ action: "documento.autenticar_govcarpeta" }).lean()).toMatchObject({
      actorType: "sistema",
      resource: `documento:${DOC}`,
      resourceOwner: ANA,
      delegated: true,
      outcome: "exito",
    });
  });

  test("los logs no contienen la cedula, el titulo ni la URL firmada", async () => {
    const lines = [];
    logger.setSink((line) => lines.push(line));

    await handlers.autenticacionSolicitada(SOLICITUD);

    const all = lines.join("\n");
    expect(all).not.toContain("1000000001");
    expect(all).not.toContain("Diploma de grado");
    expect(all).not.toContain("X-Amz");
  });
});

describe("Autenticacion fallida", () => {
  test("rechazo definitivo (501): publica documento.autenticacion_fallida con motivo 'rechazado' y confirma el mensaje", async () => {
    build({
      govImpl: async () => {
        throw definitivo(501);
      },
    });

    await expect(handlers.autenticacionSolicitada(SOLICITUD)).resolves.toBeUndefined();

    expect(publisher.publish).toHaveBeenCalledWith("documento.autenticacion_fallida", expect.objectContaining({ eventId: `${DOC}-auth-1-fallo`, motivo: "rechazado", intento: 1 }));
  });

  test("GovCarpeta no responde tras los 3 intentos: publica la falla Y el mensaje va a la cola de fallidos", async () => {
    build({
      govImpl: async () => {
        throw agotado();
      },
    });

    await expect(handlers.autenticacionSolicitada(SOLICITUD)).rejects.toBeInstanceOf(PermanentError);

    expect(publisher.publish).toHaveBeenCalledWith("documento.autenticacion_fallida", expect.objectContaining({ motivo: "no_disponible" }));
    expect(await AuthenticationAttempt.findOne({ eventId: SOLICITUD.eventId }).lean()).toMatchObject({ estado: "fallido", motivo: "no_disponible", llamadasGovCarpeta: 3 });
  });
});

describe("Idempotencia (el bus entrega al menos una vez)", () => {
  test("una reentrega de una solicitud ya resuelta NO vuelve a llamar a GovCarpeta ni publica de nuevo", async () => {
    await handlers.autenticacionSolicitada(SOLICITUD);
    await handlers.autenticacionSolicitada(SOLICITUD);

    expect(govCarpeta.authenticateDocument).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  test("8 entregas simultaneas: una sola llamada a GovCarpeta", async () => {
    build({ govImpl: () => new Promise((r) => setTimeout(() => r({ status: 200, mensaje: "ok", intentos: 1 }), 50)) });

    await Promise.all(Array.from({ length: 8 }, () => handlers.autenticacionSolicitada(SOLICITUD)));

    expect(govCarpeta.authenticateDocument).toHaveBeenCalledTimes(1);
  });

  test("si el broker no confirma el resultado, el reintento REPUBLICA el mismo resultado sin volver a llamar a GovCarpeta", async () => {
    let fallar = true;
    build({
      publishImpl: async () => {
        if (fallar) throw new Error("broker caido");
      },
    });

    await expect(handlers.autenticacionSolicitada(SOLICITUD)).rejects.toThrow("broker caido");
    fallar = false;
    await handlers.autenticacionSolicitada(SOLICITUD);

    expect(govCarpeta.authenticateDocument).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(publisher.publish.mock.calls[1][1].eventId).toBe(publisher.publish.mock.calls[0][1].eventId);
    expect((await AuthenticationAttempt.findOne({ eventId: SOLICITUD.eventId }).lean()).resultadoPublicado).toBe(true);
  });

  test("un fallo propio antes de llamar a GovCarpeta libera el intento: la reentrega lo procesa", async () => {
    storage.presignedGetUrl.mockRejectedValueOnce(new Error("sin credenciales de storage"));

    await expect(handlers.autenticacionSolicitada(SOLICITUD)).rejects.toThrow("sin credenciales de storage");
    await handlers.autenticacionSolicitada(SOLICITUD);

    expect(govCarpeta.authenticateDocument).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith("documento.autenticado", expect.any(Object));
  });

  test("un nuevo intento del mismo documento (tras un fallo) SI se procesa: es otro eventId", async () => {
    await handlers.autenticacionSolicitada(SOLICITUD);
    await handlers.autenticacionSolicitada({ ...SOLICITUD, eventId: `${DOC}-auth-2`, intento: 2 });

    expect(govCarpeta.authenticateDocument).toHaveBeenCalledTimes(2);
  });
});

describe("Mensajes invalidos -> cola de fallidos, sin llamar a GovCarpeta", () => {
  test.each([
    ["no es objeto", "x"],
    ["sin eventId", { ...SOLICITUD, eventId: undefined }],
    ["cedula como texto", { ...SOLICITUD, documento: "1000000001" }],
    ["cedula no positiva", { ...SOLICITUD, documento: 0 }],
    ["titulo vacio", { ...SOLICITUD, titulo: "  " }],
    ["intento invalido", { ...SOLICITUD, intento: 0 }],
    ["clave de otro ciudadano", { ...SOLICITUD, storageKey: "ciudadanos/6aae9153b7655900026073f2/x.pdf" }],
    ["clave fuera del prefijo", { ...SOLICITUD, storageKey: "respaldos/dump.gz" }],
  ])("%s", async (_caso, payload) => {
    await expect(handlers.autenticacionSolicitada(payload)).rejects.toBeInstanceOf(PermanentError);
    expect(govCarpeta.authenticateDocument).not.toHaveBeenCalled();
  });

  test("parseSolicitud normaliza el titulo", () => {
    expect(parseSolicitud({ ...SOLICITUD, titulo: "  Diploma  " }).titulo).toBe("Diploma");
  });
});
