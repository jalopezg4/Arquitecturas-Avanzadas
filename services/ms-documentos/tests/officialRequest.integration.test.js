/**
 * HU-06.4 (RF-31): el ciudadano pide a la entidad emisora el documento OFICIAL de un temporal; la entidad lo entrega por
 * HU-10 indicando la solicitud y el definitivo REEMPLAZA al temporal. Nombres alineados con el issue #57.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const buildApp = require("../src/app");
const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const OfficialRequest = require("../src/domain/OfficialRequest");
const AuditEntry = require("../src/domain/AuditEntry");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const SecretsManager = require("../src/security/SecretsManager");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { DocumentService } = require("../src/application/DocumentService");
const { InboundDocumentService } = require("../src/application/InboundDocumentService");
const { OfficialRequestService } = require("../src/application/OfficialRequestService");
const OfficialRequestReconciler = require("../src/application/OfficialRequestReconciler");
const { makeOfficialRequestResolvedHandler } = require("../src/interfaces/eventHandlers");
const { pdf, makeFakeStorage, makeFakePublisher, validMeta } = require("./helpers");

const ANA = "6aae9153b7655900026073f1";
const BETO = "6aae9153b7655900026073f2";
const EAFIT = "6ab68fddb64d2aa730b415e1";
const OTRA = "6ab68fddb64d2aa730b415e2";
const DIR_ANA = "1000000001-ab12cd34@carpetacolombia.co";
const NIT_EAFIT = "890.901.389-5";
const secrets = new SecretsManager({ active: "k9Xv2mQ7pL4wZ8rT1nB6yH3jD5fG0sAe" });
const entitySecrets = new SecretsManager({ active: "Wd6nK2pR8vZ4tQ1yB7mX3jL5hG9sCe0A" });
const citizen = (sub = ANA) => secrets.sign({ typ: "access" }, { issuer: "ms-identidad", subject: sub, expiresIn: 900 });
const entity = (sub = EAFIT, ver = true) => entitySecrets.sign({ typ: "access", act: "entidad", ver }, { issuer: "ms-comparticion", subject: sub, expiresIn: 900 });

let mongoServer;
let storage;
let publisher;
let official;
let resolved;
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
  await Promise.all([Document.createIndexes(), Folder.createIndexes(), OfficialRequest.createIndexes()]);
  storage = makeFakeStorage();
  publisher = makeFakePublisher();
  const documentRepository = new DocumentRepository();
  const folderRepository = new FolderRepository();
  const auditLogger = new AuditLogger({ auditRepository: new AuditRepository() });
  const documentService = new DocumentService({ documentRepository, folderRepository, storage, eventPublisher: publisher, auditLogger, quota: 5, maxUploadBytes: 1024 * 1024, downloadTtlSeconds: 3600, eventPublishTimeoutMs: 200 });
  official = new OfficialRequestService({ documentRepository, folderRepository, storage, eventPublisher: publisher, auditLogger, eventPublishTimeoutMs: 200 });
  const inboundDocumentService = new InboundDocumentService({ documentService, documentRepository, folderRepository, maxInboundBytes: 1024 * 1024, officialRequestService: official });
  resolved = makeOfficialRequestResolvedHandler({ officialRequestService: official });
  app = buildApp({ documentService, inboundDocumentService, officialRequestService: official, secrets, entitySecrets, issuer: "ms-identidad", entityIssuer: "ms-comparticion", auditLogger, maxUploadBytes: 1024 * 1024, maxInboundBytes: 1024 * 1024 });
  await Folder.create({ ciudadanoId: ANA, direccionUnica: DIR_ANA, documento: 1000000001 });
});

async function temporalDeAna() {
  const res = await request(app)
    .post(`/api/v1/citizens/${ANA}/documents`)
    .set("Authorization", `Bearer ${citizen()}`)
    .field("titulo", "Acta de grado (copia)")
    .field("entidadAvaladora", validMeta.entidadAvaladora)
    .field("fecha", validMeta.fecha)
    .attach("archivo", pdf(), { filename: "a.pdf", contentType: "application/pdf" })
    .expect(201);
  return res.body.documentoId;
}
const pedir = (docId, body = { nit: NIT_EAFIT, descripcion: "Necesito el acta oficial" }, token = citizen()) =>
  request(app).post(`/api/v1/documents/${docId}/request-official`).set("Authorization", `Bearer ${token}`).send(body);
const entregar = (fields, token = entity()) => {
  let req = request(app).post("/api/v1/documents/inbound").set("Authorization", `Bearer ${token}`);
  for (const [k, v] of Object.entries({ destinatario: DIR_ANA, envioId: "envio-oficial-0001", titulo: "Acta de grado", entidadAvaladora: "Universidad EAFIT", fecha: "2026-03-15", ...fields })) req = req.field(k, v);
  return req.attach("archivo", pdf(400), { filename: "acta.pdf", contentType: "application/pdf" });
};

/** Pide la solicitud y simula la respuesta de ms-comparticion: queda `pendiente` para EAFIT. */
async function solicitudPendiente() {
  const docId = await temporalDeAna();
  const res = await pedir(docId).expect(202);
  await resolved({ solicitudOficialId: res.body.solicitudOficialId, institutionId: EAFIT, nombre: "Universidad EAFIT" });
  return { docId, solicitudOficialId: res.body.solicitudOficialId };
}

describe("Escenario: ciudadano solicita el documento oficial", () => {
  test("202: la solicitud queda vinculada al documento temporal y se pregunta a ms-comparticion por el NIT", async () => {
    const docId = await temporalDeAna();

    const res = await pedir(docId).expect(202);

    expect(res.body).toMatchObject({ documentoTemporalId: docId, tituloDocumento: "Acta de grado (copia)", nit: "890901389", estado: "resolviendo" });
    const [rk, payload] = publisher.publish.mock.calls.find(([k]) => k === "solicitud_oficial.creada");
    expect(rk).toBe("solicitud_oficial.creada");
    expect(payload).toEqual({ solicitudOficialId: res.body.solicitudOficialId, nit: "890901389" });
  });

  test("resuelta a una entidad -> pendiente; NIT no afiliado -> sin_entidad (el ciudadano lo ve)", async () => {
    const d1 = await temporalDeAna();
    const d2 = await temporalDeAna();
    const a = (await pedir(d1).expect(202)).body.solicitudOficialId;
    const b = (await pedir(d2, { nit: "900.123.456-8" }).expect(202)).body.solicitudOficialId;

    await resolved({ solicitudOficialId: a, institutionId: EAFIT, nombre: "Universidad EAFIT" });
    await resolved({ solicitudOficialId: b, institutionId: null });

    const res = await request(app).get("/api/v1/citizens/me/official-requests").set("Authorization", `Bearer ${citizen()}`).expect(200);
    expect(Object.fromEntries(res.body.solicitudes.map((s) => [s.solicitudOficialId, s.estado]))).toEqual({ [a]: "pendiente", [b]: "sin_entidad" });
  });

  test.each([
    ["un documento certificado", async () => String((await Document.create({ ciudadanoId: ANA, titulo: "x", entidadAvaladora: "x", fecha: new Date(), storageKey: `ciudadanos/${ANA}/c.pdf`, mimeType: "application/pdf", tamanoBytes: 1, sha256: "a".repeat(64), estado: "certificado" }))._id), { nit: NIT_EAFIT }, 400],
    ["un NIT con digito de verificacion errado", temporalDeAna, { nit: "890.901.389-4" }, 400],
    ["sin NIT", temporalDeAna, {}, 400],
  ])("rechaza %s", async (_caso, makeDoc, body, code) => {
    await pedir(await makeDoc(), body).expect(code);
  });

  test("pedirla dos veces para el mismo temporal -> 409 (una sola abierta)", async () => {
    const docId = await temporalDeAna();
    await pedir(docId).expect(202);
    await pedir(docId).expect(409);
  });

  test("un documento ajeno -> 403 (y bitacora); inexistente -> 404; sin token -> 401", async () => {
    const docId = await temporalDeAna();
    await pedir(docId, undefined, citizen(BETO)).expect(403);
    expect(await AuditEntry.findOne({ action: "documento.solicitar_oficial", outcome: "rechazo" }).lean()).toMatchObject({ actor: BETO, resourceOwner: ANA, reason: "no_es_dueno" });
    await pedir("6ab68fddb64d2aa730b415ff").expect(404);
    await request(app).post(`/api/v1/documents/${docId}/request-official`).send({ nit: NIT_EAFIT }).expect(401);
  });
});

describe("Bandeja de la entidad", () => {
  test("la entidad verificada ve SOLO sus pendientes, con la direccion unica para entregar", async () => {
    const { solicitudOficialId } = await solicitudPendiente();

    const res = await request(app).get("/api/v1/official-requests").set("Authorization", `Bearer ${entity()}`).expect(200);
    expect(res.body.solicitudes).toEqual([expect.objectContaining({ solicitudOficialId, destinatario: DIR_ANA, tituloDocumento: "Acta de grado (copia)" })]);

    const otra = await request(app).get("/api/v1/official-requests").set("Authorization", `Bearer ${entity(OTRA)}`).expect(200);
    expect(otra.body.solicitudes).toEqual([]);
  });

  test("entidad no verificada -> 403; token de ciudadano -> 401", async () => {
    await request(app).get("/api/v1/official-requests").set("Authorization", `Bearer ${entity(EAFIT, false)}`).expect(403);
    await request(app).get("/api/v1/official-requests").set("Authorization", `Bearer ${citizen()}`).expect(401);
  });
});

describe("Escenario: entidad publica el documento definitivo (HU-10)", () => {
  test("la entrega que indica la solicitud la atiende y el certificado REEMPLAZA al temporal (se borra y libera cupo)", async () => {
    const { docId, solicitudOficialId } = await solicitudPendiente();
    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).noCertificados).toBe(1);

    const res = await entregar({ solicitudOficialId }).expect(201);

    const sol = await OfficialRequest.findById(solicitudOficialId).lean();
    expect(sol).toMatchObject({ estado: "atendida", abierta: false, documentoDefinitivoId: res.body.documentoId });
    expect(await Document.findById(docId).lean()).toBeNull(); // el temporal ya no esta
    expect((await Document.findById(res.body.documentoId).lean()).estado).toBe("certificado");
    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).noCertificados).toBe(0);
    expect(await AuditEntry.findOne({ action: "documento.reemplazar_temporal" }).lean()).toMatchObject({ actor: EAFIT, actorType: "entidad", resourceOwner: ANA, delegated: true });
  });

  test("un reintento del mismo envio responde 200 y no cambia nada mas", async () => {
    const { solicitudOficialId } = await solicitudPendiente();
    const first = await entregar({ solicitudOficialId }).expect(201);
    const again = await entregar({ solicitudOficialId }).expect(200);
    expect(again.body.documentoId).toBe(first.body.documentoId);
  });

  test.each([
    ["de otra entidad", () => entity(OTRA)],
    ["ya atendida (nuevo envio)", null],
  ])("una solicitud %s -> 409 y NO se guarda el documento", async (caso, tokenFn) => {
    const { solicitudOficialId } = await solicitudPendiente();
    if (!tokenFn) await entregar({ solicitudOficialId }).expect(201);
    const antes = await Document.countDocuments();

    await entregar({ solicitudOficialId, envioId: "envio-oficial-0002" }, tokenFn ? tokenFn() : entity()).expect(409);

    expect(await Document.countDocuments()).toBe(antes);
  });

  test("una solicitud de OTRO ciudadano no se puede atender entregando a Ana -> 409", async () => {
    await Folder.create({ ciudadanoId: BETO, direccionUnica: "2-cd@carpetacolombia.co" });
    const betoDoc = String((await Document.create({ ciudadanoId: BETO, titulo: "x", entidadAvaladora: "x", fecha: new Date(), storageKey: `ciudadanos/${BETO}/t.pdf`, mimeType: "application/pdf", tamanoBytes: 1, sha256: "a".repeat(64) }))._id);
    const sol = (await pedir(betoDoc, { nit: NIT_EAFIT }, citizen(BETO)).expect(202)).body.solicitudOficialId;
    await resolved({ solicitudOficialId: sol, institutionId: EAFIT });

    await entregar({ solicitudOficialId: sol }).expect(409); // destinatario es Ana
  });

  // Revision del PR #90: el reintento de un envio no puede saltarse el control de dueno de la solicitud.
  test("repetir un envio anterior indicando la solicitud de OTRO ciudadano -> 409; su temporal sigue intacto", async () => {
    await entregar({}).expect(201); // envio normal de EAFIT a Ana
    await Folder.create({ ciudadanoId: BETO, direccionUnica: "2-cd@carpetacolombia.co" });
    const betoDoc = String((await Document.create({ ciudadanoId: BETO, titulo: "x", entidadAvaladora: "x", fecha: new Date(), storageKey: `ciudadanos/${BETO}/t.pdf`, mimeType: "application/pdf", tamanoBytes: 1, sha256: "a".repeat(64) }))._id);
    const sol = (await pedir(betoDoc, { nit: NIT_EAFIT }, citizen(BETO)).expect(202)).body.solicitudOficialId;
    await resolved({ solicitudOficialId: sol, institutionId: EAFIT });

    await entregar({ solicitudOficialId: sol }).expect(409); // mismo envioId, archivo y destinatario

    expect((await OfficialRequest.findById(sol).lean()).estado).toBe("pendiente");
    expect(await Document.findById(betoDoc).lean()).not.toBeNull();
  });

  test("repetir un envio anterior indicando una solicitud de OTRA entidad -> 409; la solicitud sigue pendiente", async () => {
    const { docId, solicitudOficialId } = await solicitudPendiente(); // pendiente para EAFIT
    await entregar({ envioId: "envio-otra-000001" }, entity(OTRA)).expect(201); // envio normal de OTRA a Ana

    await entregar({ envioId: "envio-otra-000001", solicitudOficialId }, entity(OTRA)).expect(409);

    expect((await OfficialRequest.findById(solicitudOficialId).lean()).estado).toBe("pendiente");
    expect(await Document.findById(docId).lean()).not.toBeNull();
  });

  test("repetir un envio anterior indicando una solicitud que atendio OTRO envio -> 409", async () => {
    const { solicitudOficialId } = await solicitudPendiente();
    await entregar({ envioId: "envio-normal-00001" }).expect(201);
    await entregar({ solicitudOficialId }).expect(201); // la atiende envio-oficial-0001

    await entregar({ envioId: "envio-normal-00001", solicitudOficialId }).expect(409);
  });

  // Revision del PR #90: si el reemplazo del temporal se corta despues de marcar la solicitud, el reintento lo termina.
  test("si borrar el temporal falla tras marcar la solicitud, el reintento del envio lo borra y libera el cupo", async () => {
    const { docId, solicitudOficialId } = await solicitudPendiente();
    const repo = official.documentRepository;
    const real = repo.deleteByIds.bind(repo);
    repo.deleteByIds = jest.fn().mockRejectedValueOnce(new Error("mongo no disponible")).mockImplementation(real);

    await entregar({ solicitudOficialId }).expect(500);
    expect((await OfficialRequest.findById(solicitudOficialId).lean()).estado).toBe("atendida");
    expect(await Document.findById(docId).lean()).not.toBeNull(); // nunca un documento sin archivo
    expect(storage.delete).not.toHaveBeenCalled();

    await entregar({ solicitudOficialId }).expect(200); // reintento del mismo envio
    expect(await Document.findById(docId).lean()).toBeNull();
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).noCertificados).toBe(0);
  });

  test("complete() no cierra una solicitud de otra entidad ni de otro ciudadano", async () => {
    const { docId, solicitudOficialId } = await solicitudPendiente();
    expect(await official.complete({ solicitudOficialId, documentoDefinitivoId: "x", institutionId: OTRA, ciudadanoId: ANA })).toEqual({ replaced: false });
    expect(await official.complete({ solicitudOficialId, documentoDefinitivoId: "x", institutionId: EAFIT, ciudadanoId: BETO })).toEqual({ replaced: false });
    expect((await OfficialRequest.findById(solicitudOficialId).lean()).estado).toBe("pendiente");
    expect(await Document.findById(docId).lean()).not.toBeNull();
  });

  test("una entrega normal (sin solicitud) sigue funcionando igual que en HU-10", async () => {
    await entregar({}).expect(201);
  });
});

describe("Consistencia", () => {
  test("respuesta repetida o atrasada de ms-comparticion no cambia una solicitud ya resuelta", async () => {
    const { solicitudOficialId } = await solicitudPendiente();
    await resolved({ solicitudOficialId, institutionId: null });
    expect((await OfficialRequest.findById(solicitudOficialId).lean()).estado).toBe("pendiente");
  });

  test("broker caido al crear: el reconciliador reenvia la pregunta", async () => {
    const docId = await temporalDeAna();
    publisher.publish.mockRejectedValueOnce(new Error("broker caido"));
    await pedir(docId).expect(202);

    const r = new OfficialRequestReconciler({ officialRequestService: official, minAgeMs: 0 });
    expect(await r.reconcileOnce()).toEqual({ republished: 1, failed: 0 });
  });

  test("mensaje de resolucion mal formado -> cola de fallidos", async () => {
    await expect(resolved({ solicitudOficialId: "x" })).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("Aviso a la entidad de una solicitud nueva", () => {
  const avisos = () => publisher.publish.mock.calls.filter(([k]) => k === "solicitud_oficial.pendiente").map(([, p]) => p);

  test("al resolverse a una entidad con correo de contacto, se pide el aviso (sin enlaces ni datos del storage)", async () => {
    const docId = await temporalDeAna();
    const { solicitudOficialId } = (await pedir(docId).expect(202)).body;

    await resolved({ solicitudOficialId, institutionId: EAFIT, nombre: "Universidad EAFIT", correoContacto: "registro@eafit.edu.co" });

    expect(avisos()).toEqual([
      {
        eventId: solicitudOficialId,
        solicitudOficialId,
        ciudadanoId: ANA,
        correo: "registro@eafit.edu.co",
        nombreEntidad: "Universidad EAFIT",
        tituloDocumento: "Acta de grado (copia)",
        descripcion: "Necesito el acta oficial",
        remitenteDireccionUnica: DIR_ANA,
      },
    ]);
    expect((await OfficialRequest.findById(solicitudOficialId).lean()).avisoPublicado).toBe(true);
  });

  test("una resolucion repetida no manda otro aviso; sin entidad no hay aviso", async () => {
    const d1 = await temporalDeAna();
    const d2 = await temporalDeAna();
    const a = (await pedir(d1).expect(202)).body.solicitudOficialId;
    const b = (await pedir(d2).expect(202)).body.solicitudOficialId;

    await resolved({ solicitudOficialId: a, institutionId: EAFIT, correoContacto: "registro@eafit.edu.co" });
    await resolved({ solicitudOficialId: a, institutionId: EAFIT, correoContacto: "registro@eafit.edu.co" });
    await resolved({ solicitudOficialId: b, institutionId: null });

    expect(avisos()).toHaveLength(1);
  });

  test("un correo de contacto con varios destinatarios se descarta (no se avisa, la solicitud queda igual)", async () => {
    const docId = await temporalDeAna();
    const { solicitudOficialId } = (await pedir(docId).expect(202)).body;

    await resolved({ solicitudOficialId, institutionId: EAFIT, correoContacto: "a@b.co,c@d.co" });

    expect(avisos()).toHaveLength(0);
    expect((await OfficialRequest.findById(solicitudOficialId).lean()).estado).toBe("pendiente");
  });

  test("si el broker no confirma el aviso, el reconciliador lo reenvia", async () => {
    const docId = await temporalDeAna();
    const { solicitudOficialId } = (await pedir(docId).expect(202)).body;
    publisher.publish.mockImplementationOnce(async () => {
      throw new Error("broker caido");
    });

    await resolved({ solicitudOficialId, institutionId: EAFIT, correoContacto: "registro@eafit.edu.co" });
    expect((await OfficialRequest.findById(solicitudOficialId).lean()).avisoPublicado).toBe(false);

    await new OfficialRequestReconciler({ officialRequestService: official, minAgeMs: 0 }).reconcileOnce();
    expect((await OfficialRequest.findById(solicitudOficialId).lean()).avisoPublicado).toBe(true);
  });
});

