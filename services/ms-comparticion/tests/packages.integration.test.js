/**
 * HU-06.2, ola 1: paquetes documentales en ms-comparticion -- creacion por el ciudadano, eleccion del canal (carpeta
 * institucional solo para entidades VERIFICADAS, correo en otro caso), resultado de ms-documentos y consultas.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Institution = require("../src/domain/Institution");
const Package = require("../src/domain/Package");
const AuditEntry = require("../src/domain/AuditEntry");
const { InstitutionRepository } = require("../src/infrastructure/InstitutionRepository");
const PackageRepository = require("../src/infrastructure/PackageRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const SecretsManager = require("../src/security/SecretsManager");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { InstitutionService } = require("../src/application/InstitutionService");
const { PackageService } = require("../src/application/PackageService");
const PackageEventReconciler = require("../src/application/PackageEventReconciler");
const { makePackageProcessedHandler } = require("../src/interfaces/eventHandlers");

const ANA = "6aae9153b7655900026073f1";
const BETO = "6aae9153b7655900026073f2";
const D1 = "6ab68fddb64d2aa730b415b1";
const D2 = "6ab68fddb64d2aa730b415b2";
const EAFIT = "890.901.389-5";
const secrets = new SecretsManager({ active: "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe" });
const entitySecrets = new SecretsManager({ active: "Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A" });
const citizenToken = (sub = ANA) => secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: sub, expiresIn: 900 });
const entityToken = (sub, ver = true) => entitySecrets.sign({ typ: "access", act: "entidad", ver }, { issuer: "ms-comparticion", subject: sub, expiresIn: 900 });

let mongoServer;
let publisher;
let service;
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
  await mongoose.connection.dropDatabase();
});
beforeEach(async () => {
  await Promise.all([Institution.createIndexes(), Package.createIndexes(), AuditEntry.createIndexes()]);
  publisher = { publish: jest.fn(async () => {}) };
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const institutionService = new InstitutionService({ institutionRepository: new InstitutionRepository(), auditLogger });
  service = new PackageService({ packageRepository: new PackageRepository(), institutionService, eventPublisher: publisher, auditLogger, maxDocumentos: 3, eventPublishTimeoutMs: 200, now: () => new Date("2026-09-26T15:00:00Z") });
  app = buildApp({ institutionService, packageService: service, secrets, issuer: "ms-identidad", entitySecrets, auditLogger });
});

async function institucion({ verificada }) {
  const res = await request(app).post("/api/v1/institutions").send({ nombre: "Universidad EAFIT", tipo: "universidad", nit: EAFIT, correoContacto: "registro@eafit.edu.co" }).expect(201);
  if (verificada) await Institution.updateOne({ _id: res.body.institutionId }, { verificada: true });
  return res.body.institutionId;
}
const crear = (body, token = citizenToken()) => request(app).post("/api/v1/packages").set("Authorization", `Bearer ${token}`).send(body);
const creados = () => publisher.publish.mock.calls.filter(([rk]) => rk === "paquete.creado").map(([, p]) => p);

describe("POST /api/v1/packages: el canal de entrega", () => {
  test("entidad registrada Y verificada -> carpeta institucional (RF-25); publica paquete.creado con REFERENCIAS", async () => {
    const institutionId = await institucion({ verificada: true });

    const res = await crear({ documentoIds: [D1, D2, D1], destinatario: { nit: EAFIT } }).expect(202);

    expect(res.body).toMatchObject({ canal: "carpeta_institucional", estado: "procesando", destino: { tipo: "institucion", nombre: "Universidad EAFIT" } });
    expect(creados()).toEqual([{ paqueteId: res.body.paqueteId, ciudadanoId: ANA, documentoIds: [D1, D2], canal: "carpeta_institucional", institutionId, correoDestino: null, nombreDestino: "Universidad EAFIT" }]);
  });

  test("entidad registrada pero NO verificada -> correo a su contacto registrado (decision del equipo, ADR-07)", async () => {
    await institucion({ verificada: false });

    const res = await crear({ documentoIds: [D1], destinatario: { nit: EAFIT, correo: "otro@x.co" } }).expect(202);

    expect(res.body).toMatchObject({ canal: "correo", destino: { tipo: "correo", correo: "registro@eafit.edu.co" } });
  });

  test("entidad no afiliada -> correo al que indique el ciudadano (RF-26)", async () => {
    const res = await crear({ documentoIds: [D1], destinatario: { nit: "900.123.456-7", correo: "RRHH@Empresa.co", nombre: "Empresa X" } }).expect(202);
    expect(res.body).toMatchObject({ canal: "correo", destino: { correo: "rrhh@empresa.co", nombre: "Empresa X" } });
  });

  test("entidad no afiliada y sin correo -> 400 (no hay a donde enviarlo)", async () => {
    await crear({ documentoIds: [D1], destinatario: { nit: "900.123.456-7" } }).expect(400);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  test.each([
    ["sin documentos", { documentoIds: [], destinatario: { correo: "a@b.co" } }],
    ["mas del maximo por paquete", { documentoIds: [D1, D2, "6ab68fddb64d2aa730b415b3", "6ab68fddb64d2aa730b415b4"], destinatario: { correo: "a@b.co" } }],
    ["id invalido", { documentoIds: ["../x"], destinatario: { correo: "a@b.co" } }],
    ["varios destinatarios en el correo", { documentoIds: [D1], destinatario: { correo: "a@b.co,c@d.co" } }],
    ["sin destinatario", { documentoIds: [D1] }],
  ])("%s -> 400", async (_caso, body) => {
    await crear(body).expect(400);
  });

  test("sin token -> 401; con token INSTITUCIONAL -> 401 (una entidad no arma paquetes de un ciudadano)", async () => {
    await request(app).post("/api/v1/packages").send({ documentoIds: [D1], destinatario: { correo: "a@b.co" } }).expect(401);
    await crear({ documentoIds: [D1], destinatario: { correo: "a@b.co" } }, entityToken("6ab68fddb64d2aa730b415cc")).expect(401);
  });

  test("queda en la bitacora quien armo el paquete y el canal", async () => {
    await crear({ documentoIds: [D1], destinatario: { correo: "a@b.co" } }).expect(202);
    expect(await AuditEntry.findOne({ action: "paquete.crear" }).lean()).toMatchObject({ actor: ANA, actorType: "ciudadano", outcome: "exito", metadata: { canal: "correo", documentos: 1 } });
  });
});

describe("paquete.procesado (respuesta de ms-documentos) y consultas", () => {
  test("ok -> entregado con los metadatos; la entidad lo ve en su carpeta; el ciudadano tambien", async () => {
    const institutionId = await institucion({ verificada: true });
    const { body } = await crear({ documentoIds: [D1], destinatario: { nit: EAFIT } }).expect(202);
    const handler = makePackageProcessedHandler({ packageService: service });

    await handler({ paqueteId: body.paqueteId, ok: true, documentos: [{ documentoId: D1, titulo: "Diploma", entidadAvaladora: "EAFIT", fecha: "2026-03-15T00:00:00.000Z", mimeType: "application/pdf" }], remitenteDireccionUnica: "1-ab@carpetacolombia.co" });
    await handler({ paqueteId: body.paqueteId, ok: false, motivo: "tarde" }); // repetido/atrasado: no cambia nada

    const recibidos = await request(app).get("/api/v1/institutions/me/packages").set("Authorization", `Bearer ${entityToken(institutionId)}`).expect(200);
    expect(recibidos.body).toMatchObject({ total: 1, paquetes: [{ paqueteId: body.paqueteId, remitente: "1-ab@carpetacolombia.co", documentos: [{ documentoId: D1, titulo: "Diploma" }] }] });

    const mio = await request(app).get(`/api/v1/citizens/me/packages/${body.paqueteId}`).set("Authorization", `Bearer ${citizenToken()}`).expect(200);
    expect(mio.body).toMatchObject({ estado: "entregado", documentos: [{ titulo: "Diploma" }] });
  });

  test("no -> rechazado con motivo; no aparece en la carpeta de la entidad", async () => {
    const institutionId = await institucion({ verificada: true });
    const { body } = await crear({ documentoIds: [D1], destinatario: { nit: EAFIT } }).expect(202);

    await makePackageProcessedHandler({ packageService: service })({ paqueteId: body.paqueteId, ok: false, motivo: "documento_no_es_del_ciudadano" });

    expect((await Package.findById(body.paqueteId).lean()).estado).toBe("rechazado");
    const recibidos = await request(app).get("/api/v1/institutions/me/packages").set("Authorization", `Bearer ${entityToken(institutionId)}`).expect(200);
    expect(recibidos.body.total).toBe(0);
  });

  test("una entidad cuya verificacion se REVOCO no ve su carpeta, aunque su token diga ver:true (403 inmediato)", async () => {
    const institutionId = await institucion({ verificada: true });
    await Institution.updateOne({ _id: institutionId }, { verificada: false });

    await request(app).get("/api/v1/institutions/me/packages").set("Authorization", `Bearer ${entityToken(institutionId, true)}`).expect(403);
    expect(await AuditEntry.findOne({ action: "paquete.listar" }).lean()).toMatchObject({ outcome: "rechazo", reason: "entidad_no_verificada" });
  });

  test("un paquete ajeno responde 404 (no se revela que existe); la lista del ciudadano solo trae los suyos", async () => {
    const { body } = await crear({ documentoIds: [D1], destinatario: { correo: "a@b.co" } }, citizenToken(BETO)).expect(202);

    await request(app).get(`/api/v1/citizens/me/packages/${body.paqueteId}`).set("Authorization", `Bearer ${citizenToken()}`).expect(404);
    const lista = await request(app).get("/api/v1/citizens/me/packages").set("Authorization", `Bearer ${citizenToken()}`).expect(200);
    expect(lista.body.total).toBe(0);
  });

  test("respuesta mal formada -> cola de fallidos", async () => {
    await expect(makePackageProcessedHandler({ packageService: service })({ paqueteId: "x", ok: true })).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("Broker caido al crear", () => {
  test("responde 202 igual; el reconciliador reenvia paquete.creado", async () => {
    publisher.publish.mockRejectedValueOnce(new Error("broker caido"));
    const { body } = await crear({ documentoIds: [D1], destinatario: { correo: "a@b.co" } }).expect(202);
    expect((await Package.findById(body.paqueteId).lean()).eventoPublicado).toBe(false);

    const reconciler = new PackageEventReconciler({ packageRepository: new PackageRepository(), packageService: service, minAgeMs: 0 });
    expect(await reconciler.reconcileOnce()).toEqual({ republished: 1, failed: 0 });
    expect((await Package.findById(body.paqueteId).lean()).eventoPublicado).toBe(true);
  });
});
