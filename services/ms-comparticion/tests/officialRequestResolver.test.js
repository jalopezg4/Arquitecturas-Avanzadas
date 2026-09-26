/**
 * HU-06.4: ms-comparticion (duena de las entidades) dice a que institucion corresponde el NIT de una solicitud del
 * documento oficial. No exige que este verificada: eso lo exige ms-documentos al mostrar la bandeja y al entregar.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Institution = require("../src/domain/Institution");
const { InstitutionRepository } = require("../src/infrastructure/InstitutionRepository");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");
const { InstitutionService } = require("../src/application/InstitutionService");
const { makeOfficialRequestHandler } = require("../src/interfaces/eventHandlers");

const SOL = "6ab68fddb64d2aa730b41701";

let mongoServer;
let service;
let publisher;
let handler;

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
  await Institution.createIndexes();
  service = new InstitutionService({ institutionRepository: new InstitutionRepository() });
  publisher = { publish: jest.fn(async () => {}) };
  handler = makeOfficialRequestHandler({ institutionService: service, eventPublisher: publisher, timeoutMs: 200 });
});

test("NIT de una entidad registrada (aunque no este verificada) -> responde su institutionId y nombre", async () => {
  const { institutionId } = await service.register({ nombre: "Universidad EAFIT", tipo: "universidad", nit: "890.901.389-5", correoContacto: "registro@eafit.edu.co" });

  await handler({ solicitudOficialId: SOL, nit: "890901389" });

  expect(publisher.publish).toHaveBeenCalledWith("solicitud_oficial.resuelta", { solicitudOficialId: SOL, institutionId, nombre: "Universidad EAFIT", correoContacto: "registro@eafit.edu.co" });
});

test("NIT no registrado -> institutionId null", async () => {
  await handler({ solicitudOficialId: SOL, nit: "890901389" });
  expect(publisher.publish).toHaveBeenCalledWith("solicitud_oficial.resuelta", { solicitudOficialId: SOL, institutionId: null, nombre: null, correoContacto: null });
});

test("si el broker no confirma la respuesta, falla para que el mensaje se reintente", async () => {
  publisher.publish.mockRejectedValueOnce(new Error("broker caido"));
  await expect(handler({ solicitudOficialId: SOL, nit: "890901389" })).rejects.toThrow("broker caido");
});

test.each([[{ solicitudOficialId: "x", nit: "890901389" }], [{ solicitudOficialId: SOL }], [null]])("mensaje mal formado %p -> cola de fallidos", async (payload) => {
  await expect(handler(payload)).rejects.toBeInstanceOf(PermanentError);
});
