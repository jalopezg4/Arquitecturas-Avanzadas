const crypto = require("crypto");

/** PDF minimo valido (solo importa la firma %PDF-) de un tamano dado. */
function pdf(size = 200) {
  const head = Buffer.from("%PDF-1.4\n");
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)]);
}

/** Object storage en memoria con la misma interfaz que ObjectStorageAdapter y fallos inyectables. */
function makeFakeStorage() {
  const objects = new Map();
  const storage = {
    objects,
    put: jest.fn(async (key, body, type) => {
      if (storage.failPut) throw new Error("storage caido");
      objects.set(key, { body, type });
    }),
    delete: jest.fn(async (key) => {
      objects.delete(key);
    }),
    newKey: jest.fn((ciudadanoId) => `ciudadanos/${ciudadanoId}/${crypto.randomUUID()}.pdf`),
    presignedGetUrl: jest.fn(async (key, ttl) => `http://storage.test/${key}?expires=${ttl}`),
    failPut: false,
  };
  return storage;
}

function makeFakePublisher(impl) {
  return { publish: jest.fn(impl || (async () => {})) };
}

const validMeta = { titulo: "Diploma de grado", entidadAvaladora: "Universidad EAFIT", fecha: "2026-03-15" };

module.exports = { pdf, makeFakeStorage, makeFakePublisher, validMeta };
