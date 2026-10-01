/**
 * RNF-04 (revision del PR #90): la cuota se guarda por documento y el QuotaReconciler la mantiene igual a los
 * documentos que de verdad ocupan cupo. Reservar y liberar son idempotentes.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Document = require("../src/domain/Document");
const Folder = require("../src/domain/Folder");
const DocumentRepository = require("../src/infrastructure/DocumentRepository");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const QuotaReconciler = require("../src/application/QuotaReconciler");

const ANA = "6aae9153b7655900026073f1";
const NOW = new Date("2026-10-01T12:00:00Z");
const MIN_AGE = 10 * 60 * 1000;

let mongoServer;
let folders;
let reconciler;

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
  await Promise.all([Document.createIndexes(), Folder.createIndexes()]);
  folders = new FolderRepository();
  reconciler = new QuotaReconciler({ folderRepository: folders, documentRepository: new DocumentRepository(), minAgeMs: MIN_AGE, now: () => NOW });
});

/** ObjectId generado `msAtras` milisegundos antes de NOW (la hora va dentro del id). */
const crypto = require("crypto");
const idDe = (msAtras) => Math.floor((NOW.getTime() - msAtras) / 1000).toString(16).padStart(8, "0") + crypto.randomBytes(8).toString("hex");
const doc = (id, estado = "temporal") =>
  Document.create({ _id: id, ciudadanoId: ANA, titulo: "x", entidadAvaladora: "x", fecha: new Date(), storageKey: `ciudadanos/${ANA}/${id}.pdf`, mimeType: "application/pdf", tamanoBytes: 1, sha256: "a".repeat(64), estado });
const carpeta = async () => Folder.findOne({ ciudadanoId: ANA }).lean();

describe("cuota por documento", () => {
  test("reservar y liberar el mismo documento varias veces cuenta una sola vez", async () => {
    const id = idDe(0);
    expect(await folders.reserveNonCertified(ANA, id, 5)).toBe(true);
    expect(await folders.reserveNonCertified(ANA, id, 5)).toBe(true);
    expect((await carpeta()).noCertificados).toBe(1);

    await Promise.all([folders.releaseNonCertified(ANA, id), folders.releaseNonCertified(ANA, id), folders.releaseNonCertified(ANA, id)]);
    expect(await carpeta()).toMatchObject({ noCertificados: 0, cupos: [] });
  });

  test("N cargas simultaneas nunca superan la cuota", async () => {
    const ids = Array.from({ length: 10 }, () => String(new mongoose.Types.ObjectId()));
    const res = await Promise.all(ids.map((id) => folders.reserveNonCertified(ANA, id, 3)));
    expect(res.filter(Boolean)).toHaveLength(3);
    expect(await carpeta()).toMatchObject({ noCertificados: 3 });
    expect((await carpeta()).cupos).toHaveLength(3);
  });
});

describe("QuotaReconciler", () => {
  test("libera una reserva vieja sin documento y conserva la de una carga en curso", async () => {
    const vieja = idDe(MIN_AGE + 1000); // la carga fallo y su compensacion no libero el cupo
    const enCurso = idDe(1000); // aun no se crea su documento
    const conDoc = idDe(MIN_AGE * 3);
    await doc(conDoc);
    await Folder.create({ ciudadanoId: ANA, cupos: [vieja, enCurso, conDoc], noCertificados: 3 });

    expect(await reconciler.reconcileOnce()).toEqual({ liberados: 1, agregados: 0 });

    expect(await carpeta()).toMatchObject({ noCertificados: 2, cupos: [enCurso, conDoc], cuposRevisadosEn: NOW });
  });

  test("libera el cupo de un documento que ya esta certificado y cuenta un temporal que no estaba", async () => {
    const certificado = idDe(MIN_AGE * 2);
    const sinContar = idDe(MIN_AGE * 2);
    await doc(certificado, "certificado");
    await doc(sinContar, "en autenticacion");
    await Folder.create({ ciudadanoId: ANA, cupos: [certificado], noCertificados: 1 });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce(); // idempotente

    expect(await carpeta()).toMatchObject({ noCertificados: 1, cupos: [sinContar] });
  });

  test("migra las carpetas anteriores (solo contador) desde sus documentos, una sola vez", async () => {
    const a = idDe(0);
    const b = idDe(0);
    await doc(a);
    await doc(b, "en autenticacion");
    await doc(idDe(0), "certificado");
    await Folder.collection.insertOne({ ciudadanoId: ANA, noCertificados: 7 }); // documento viejo, sin `cupos`

    expect(await reconciler.migrateLegacy()).toBe(1);
    expect(await reconciler.migrateLegacy()).toBe(0);

    const f = await carpeta();
    expect(f.noCertificados).toBe(2);
    expect(f.cupos.sort()).toEqual([a, b].sort());
  });
});
