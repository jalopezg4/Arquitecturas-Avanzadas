/**
 * HU-05c: activacion de cuenta del ciudadano que llega TRANSFERIDO (sin contrasena). Recibe por correo un codigo de un
 * solo uso y con el fija su contrasena; despues inicia sesion como cualquiera.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Citizen = require("../src/domain/Citizen");
const AuditEntry = require("../src/domain/AuditEntry");
const CitizenRepository = require("../src/infrastructure/CitizenRepository");
const RefreshSessionRepository = require("../src/infrastructure/RefreshSessionRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const SecretsManager = require("../src/security/SecretsManager");
const logger = require("../src/tracing/logger");
const { AuthService } = require("../src/application/AuthService");
const { AccountActivationService } = require("../src/application/AccountActivationService");
const { CitizenTransferService } = require("../src/application/CitizenTransferService");
const ActivationReconciler = require("../src/application/ActivationReconciler");
const { makeTransferHandlers } = require("../src/interfaces/eventHandlers");

const secrets = new SecretsManager({ active: "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe" });
const NUEVO_ID = "6ab68fddb64d2aa730b415f0";
const CEDULA = 1000000001;
const PASSWORD = "Clave-segura-123";

let mongoServer;
let clock;
let publisher;
let activation;
let handlers;
let app;

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
beforeEach(async () => {
  await Citizen.createIndexes();
  clock = { now: new Date("2026-09-26T15:00:00Z") };
  publisher = { publish: jest.fn(async () => {}) };
  const citizenRepository = new CitizenRepository();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  activation = new AccountActivationService({ citizenModel: Citizen, eventPublisher: publisher, auditLogger, ttlMs: 72 * 3600 * 1000, resendCooldownMs: 5 * 60 * 1000, eventPublishTimeoutMs: 200, now: () => clock.now });
  handlers = makeTransferHandlers({
    citizenTransferService: new CitizenTransferService({
      citizenRepository,
      refreshSessionRepository: new RefreshSessionRepository(),
      govCarpetaClient: { registerCitizen: jest.fn(async () => {}), validateCitizen: jest.fn(async () => ({ available: true })) },
      eventPublisher: publisher,
      auditLogger,
      accountActivationService: activation,
      eventPublishTimeoutMs: 200,
    }),
  });
  app = buildApp({ citizenSagaService: {}, authService: new AuthService({ citizenRepository, refreshSessionRepository: new RefreshSessionRepository(), secrets, auditLogger }), secrets, activationService: activation });
});

const codigos = () => publisher.publish.mock.calls.filter(([k]) => k === "ciudadano.activacion_requerida").map(([, p]) => p);
async function llegaTransferido() {
  await handlers.registrarCiudadano({ transferenciaId: "6ab68fddb64d2aa730b41501", ciudadanoId: NUEVO_ID, documento: CEDULA, nombre: "Ana Gomez", correo: "ana@example.com", direccion: "Calle 1", direccionUnica: "1000000001-ab12cd34@carpetacolombia.co" });
  return codigos()[codigos().length - 1];
}
const activar = (body) => request(app).post("/api/v1/auth/activate").send(body);
const login = (password = PASSWORD) => request(app).post("/api/v1/auth/login").send({ documento: CEDULA, password });

describe("Al llegar transferido se le envia un codigo de activacion", () => {
  test("se publica el codigo (con su correo y vencimiento) y solo se guarda su HUELLA, nunca el codigo", async () => {
    const evento = await llegaTransferido();

    expect(evento).toMatchObject({ ciudadanoId: NUEVO_ID, nombre: "Ana Gomez", correo: "ana@example.com", venceEn: "2026-09-29T15:00:00.000Z" });
    expect(evento.codigo).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const guardado = await Citizen.findById(NUEVO_ID).lean();
    expect(guardado.activacionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(guardado)).not.toContain(evento.codigo);
  });

  test("antes de activar, el login falla con el 401 generico", async () => {
    await llegaTransferido();
    await login().expect(401);
  });
});

describe("POST /api/v1/auth/activate", () => {
  test("con el codigo correcto fija la contrasena (Argon2id) y despues el login FUNCIONA", async () => {
    const { codigo } = await llegaTransferido();

    const res = await activar({ documento: CEDULA, codigo, password: PASSWORD }).expect(200);

    expect(res.body).toEqual({ activado: true });
    expect(res.headers["cache-control"]).toBe("no-store");
    const ana = await Citizen.findById(NUEVO_ID).lean();
    expect(ana.passwordHash).toMatch(/^\$argon2id\$/);
    expect(ana.activacionHash).toBeNull();
    const tokens = await login().expect(200);
    expect(tokens.body.accessToken).toBeTruthy();
  });

  test("el codigo es de un solo uso: reusarlo -> 401 y no cambia la contrasena", async () => {
    const { codigo } = await llegaTransferido();
    await activar({ documento: CEDULA, codigo, password: PASSWORD }).expect(200);

    await activar({ documento: CEDULA, codigo, password: "Otra-clave-456" }).expect(401);
    await login().expect(200);
  });

  test("dos activaciones SIMULTANEAS con el mismo codigo: solo una gana", async () => {
    const { codigo } = await llegaTransferido();
    const codes = (await Promise.all([activar({ documento: CEDULA, codigo, password: PASSWORD }), activar({ documento: CEDULA, codigo, password: "Otra-clave-456" })])).map((r) => r.status).sort();
    expect(codes).toEqual([200, 401]);
  });

  test("codigo vencido -> 401", async () => {
    const { codigo } = await llegaTransferido();
    clock.now = new Date("2026-09-29T15:00:01Z");
    await activar({ documento: CEDULA, codigo, password: PASSWORD }).expect(401);
  });

  test.each([
    ["codigo equivocado", { codigo: "x".repeat(43) }],
    ["documento inexistente", { documento: 999999 }],
  ])("%s -> el MISMO 401 generico (no revela si el documento existe)", async (_caso, extra) => {
    const { codigo } = await llegaTransferido();
    const res = await activar({ documento: CEDULA, codigo, password: PASSWORD, ...extra }).expect(401);
    expect(res.body.error).toBe("codigo de activacion invalido o vencido");
  });

  test("una cuenta que YA tiene contrasena no se puede 'activar' (no sirve para cambiar la contrasena ajena)", async () => {
    await Citizen.create({ documento: 2, nombre: "Beto", direccion: "x", correo: "b@x.co", passwordHash: "$argon2id$algo", direccionUnica: "2-ab@carpetacolombia.co", estado: "activo", activacionHash: "a".repeat(64), activacionVenceEn: new Date("2030-01-01") });
    await activar({ documento: 2, codigo: "x".repeat(43), password: PASSWORD }).expect(401);
  });

  test("contrasena corta -> 400", async () => {
    const { codigo } = await llegaTransferido();
    await activar({ documento: CEDULA, codigo, password: "corta" }).expect(400);
  });

  test("queda en la bitacora (exito y rechazo), y el codigo nunca aparece en los logs", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(l));
    const { codigo } = await llegaTransferido();
    await activar({ documento: CEDULA, codigo: "x".repeat(43), password: PASSWORD }).expect(401);
    await activar({ documento: CEDULA, codigo, password: PASSWORD }).expect(200);

    expect(await AuditEntry.countDocuments({ action: "ciudadano.activar", outcome: "exito" })).toBe(1);
    expect(await AuditEntry.countDocuments({ action: "ciudadano.activar", outcome: "rechazo" })).toBe(1);
    expect(lines.join("\n")).not.toContain(codigo);
  });
});

describe("POST /api/v1/auth/activate/resend", () => {
  const reenviar = (documento) => request(app).post("/api/v1/auth/activate/resend").send({ documento });

  test("envia un codigo NUEVO (el anterior deja de servir), como maximo uno cada 5 minutos", async () => {
    const primero = await llegaTransferido();
    await reenviar(CEDULA).expect(202);
    expect(codigos()).toHaveLength(1); // dentro de los 5 minutos: no se reenvia

    clock.now = new Date(clock.now.getTime() + 5 * 60 * 1000);
    await reenviar(CEDULA).expect(202);
    const segundo = codigos()[1];
    expect(segundo.codigo).not.toBe(primero.codigo);

    await activar({ documento: CEDULA, codigo: primero.codigo, password: PASSWORD }).expect(401);
    await activar({ documento: CEDULA, codigo: segundo.codigo, password: PASSWORD }).expect(200);
  });

  test("responde igual (202) exista o no el documento: no sirve para averiguar quien esta afiliado", async () => {
    await llegaTransferido();
    const a = await reenviar(999999).expect(202);
    const b = await reenviar(CEDULA).expect(202);
    expect(a.body).toEqual(b.body);
  });
});

// Revision del PR #90: emision atomica (sin correos de mas) y ningun transferido se queda sin codigo.
describe("emision del codigo: atomica y garantizada", () => {
  const reenviar = (documento) => request(app).post("/api/v1/auth/activate/resend").send({ documento });
  const reconciler = () => new ActivationReconciler({ citizenModel: Citizen, activationService: activation, minAgeMs: 60000, now: () => new Date(Date.now() + 120000) });

  test("10 reenvios SIMULTANEOS pasado el enfriamiento: un solo codigo nuevo, y es el que sirve", async () => {
    await llegaTransferido();
    clock.now = new Date(clock.now.getTime() + 5 * 60 * 1000);

    await Promise.all(Array.from({ length: 10 }, () => reenviar(CEDULA).expect(202)));

    expect(codigos()).toHaveLength(2); // el de la llegada + UNO del reenvio
    await activar({ documento: CEDULA, codigo: codigos()[1].codigo, password: PASSWORD }).expect(200);
  });

  test("si el broker no confirma el codigo al llegar, el reconciliador emite otro que si sirve", async () => {
    publisher.publish.mockImplementation(async (rk) => {
      if (rk === "ciudadano.activacion_requerida") throw new Error("broker caido");
    });
    await llegaTransferido();
    expect((await Citizen.findById(NUEVO_ID).lean()).activacionPublicada).toBe(false);
    publisher.publish.mockImplementation(async () => {});

    expect(await reconciler().reconcileOnce()).toMatchObject({ emitidos: 1 });

    const nuevo = codigos()[codigos().length - 1];
    expect((await Citizen.findById(NUEVO_ID).lean()).activacionPublicada).toBe(true);
    await activar({ documento: CEDULA, codigo: nuevo.codigo, password: PASSWORD }).expect(200);
    expect(await reconciler().reconcileOnce()).toMatchObject({ emitidos: 0 });
  });

  test("activado por otro camino sin codigo (p. ej. PendingRegistrationReconciler): la reentrega lo emite", async () => {
    await Citizen.create({ _id: NUEVO_ID, documento: CEDULA, nombre: "Ana Gomez", correo: "ana@example.com", direccion: "Calle 1", direccionUnica: "1000000001-ab12cd34@carpetacolombia.co", passwordHash: null, estado: "activo", eventoPublicado: true, transferenciaOrigenId: "6ab68fddb64d2aa730b41501" });

    const evento = await llegaTransferido(); // reentrega de la orden de registrar

    expect(evento).toMatchObject({ ciudadanoId: NUEVO_ID });
    await activar({ documento: CEDULA, codigo: evento.codigo, password: PASSWORD }).expect(200);
  });

  test("...y si no hay reentrega, lo emite el reconciliador", async () => {
    await Citizen.create({ _id: NUEVO_ID, documento: CEDULA, nombre: "Ana Gomez", correo: "ana@example.com", direccion: "Calle 1", direccionUnica: "1000000001-ab12cd34@carpetacolombia.co", passwordHash: null, estado: "activo", eventoPublicado: true });

    expect(await reconciler().reconcileOnce()).toMatchObject({ emitidos: 1 });
    expect(codigos()).toHaveLength(1);
  });

  test("las reentregas de un ciudadano que ya tiene su codigo no mandan otro correo", async () => {
    await llegaTransferido();
    await llegaTransferido();
    await llegaTransferido();
    expect(codigos()).toHaveLength(1);
  });
});
