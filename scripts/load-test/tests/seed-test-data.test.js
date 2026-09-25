const { MongoMemoryServer } = require("mongodb-memory-server");
const { seed, CIUDADANO_ID, TOTAL_DOCUMENTOS } = require("../seed-test-data");
const Document = require("../../../services/ms-documentos/src/domain/Document");
const Folder = require("../../../services/ms-documentos/src/domain/Folder");

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
}, 60000);

afterAll(async () => {
  await Document.base.disconnect();
  await mongod.stop();
});

test("siembra la carpeta y los documentos esperados", async () => {
  const result = await seed(mongod.getUri("ms-documentos"));
  expect(result.creados).toBe(TOTAL_DOCUMENTOS);
  expect(result.yaExistian).toBe(0);
  expect(result.total).toBe(TOTAL_DOCUMENTOS);

  const folder = await Folder.findOne({ ciudadanoId: CIUDADANO_ID }).lean();
  expect(folder).not.toBeNull();

  const docs = await Document.find({ ciudadanoId: CIUDADANO_ID }).lean();
  expect(docs).toHaveLength(TOTAL_DOCUMENTOS);
  docs.forEach((d) => {
    expect(d.titulo).toEqual(expect.any(String));
    expect(d.storageKey).toMatch(/^ht03-loadtest\/doc-\d{2}\.pdf$/);
  });
});

test("correr seed() una segunda vez es idempotente: no duplica nada", async () => {
  const first = await seed(mongod.getUri("ms-documentos"));
  const second = await seed(mongod.getUri("ms-documentos"));

  expect(second.creados).toBe(0);
  expect(second.yaExistian).toBe(TOTAL_DOCUMENTOS);
  expect(second.total).toBe(TOTAL_DOCUMENTOS);
  expect(second.total).toBe(first.total);

  const totalReal = await Document.countDocuments({ ciudadanoId: CIUDADANO_ID });
  expect(totalReal).toBe(TOTAL_DOCUMENTOS);

  const totalFolders = await Folder.countDocuments({ ciudadanoId: CIUDADANO_ID });
  expect(totalFolders).toBe(1);
});
