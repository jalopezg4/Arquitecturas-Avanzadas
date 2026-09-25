/**
 * HU-10, bloque 1: modelo de lectura local del ciudadano en ms-documentos.
 *
 * La `direccionUnica` llega en el evento `ciudadano.registrado` que este servicio YA consumia (HU-01, paso 7) y se
 * guarda en su carpeta. Es lo que permite resolver al destinatario de un documento institucional sin consultar a
 * ms-identidad: ninguna llamada REST entre servicios (ADR-01, matriz de degradacion).
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Folder = require("../src/domain/Folder");
const FolderRepository = require("../src/infrastructure/FolderRepository");
const { makeCitizenRegisteredHandler } = require("../src/interfaces/eventHandlers");
const { PermanentError } = require("../src/infrastructure/BrokerConsumer");

const ANA = "665f1c04c9de9c4c34f6b52a";
const BETO = "665f1c04c9de9c4c34f6b52b";
const DIR_ANA = "1000000001-3f9c2ab7@carpetacolombia.co";

let mongoServer;
let folderRepository;
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
  await Folder.createIndexes(); // dropDatabase() borra los indices
  folderRepository = new FolderRepository();
  handler = makeCitizenRegisteredHandler({ folderRepository });
});

describe("ciudadano.registrado guarda la direccion unica en la carpeta", () => {
  test("crea la carpeta con cupo en cero y la direccion del evento", async () => {
    await handler({ ciudadanoId: ANA, documento: 1000000001, direccionUnica: DIR_ANA });

    expect(await Folder.findOne({ ciudadanoId: ANA }).lean()).toMatchObject({ noCertificados: 0, direccionUnica: DIR_ANA });
  });

  test("la guarda normalizada: espacios y mayusculas no crean direcciones distintas", async () => {
    await handler({ ciudadanoId: ANA, direccionUnica: `  ${DIR_ANA.toUpperCase()} ` });

    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).direccionUnica).toBe(DIR_ANA);
  });

  test("un evento repetido no duplica la carpeta ni cambia nada", async () => {
    await Promise.all(Array.from({ length: 8 }, () => handler({ ciudadanoId: ANA, direccionUnica: DIR_ANA })));
    await handler({ ciudadanoId: ANA, direccionUnica: DIR_ANA });

    expect(await Folder.countDocuments()).toBe(1);
    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).direccionUnica).toBe(DIR_ANA);
  });

  test("rellena la direccion de una carpeta que ya existia SIN pisar su contador", async () => {
    // Carpeta creada por una carga anterior al evento (o anterior a HU-10).
    await Folder.create({ ciudadanoId: ANA, noCertificados: 3 });

    await handler({ ciudadanoId: ANA, direccionUnica: DIR_ANA });

    expect(await Folder.findOne({ ciudadanoId: ANA }).lean()).toMatchObject({ noCertificados: 3, direccionUnica: DIR_ANA });
  });

  test("un evento SIN direccion (los anteriores a HU-10) sigue creando la carpeta y no borra una ya guardada", async () => {
    await handler({ ciudadanoId: ANA, direccionUnica: DIR_ANA });
    await handler({ ciudadanoId: ANA }); // reentrega de un evento viejo

    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).direccionUnica).toBe(DIR_ANA);

    await handler({ ciudadanoId: BETO });
    expect(await Folder.findOne({ ciudadanoId: BETO }).lean()).toMatchObject({ noCertificados: 0, direccionUnica: null });
  });

  test.each([["sin arroba", "no-es-una-direccion"], ["con espacios", "a b@c.co"], ["enorme", `${"x".repeat(200)}@c.co`], ["que no es texto", 42], ["objeto de consulta", { $ne: null }]])(
    "una direccion con formato inesperado (%s) NO invalida el evento: la carpeta se crea sin direccion",
    async (_name, direccionUnica) => {
      await handler({ ciudadanoId: ANA, direccionUnica });

      expect(await Folder.findOne({ ciudadanoId: ANA }).lean()).toMatchObject({ noCertificados: 0, direccionUnica: null });
    }
  );

  test("un ciudadanoId invalido sigue siendo error PERMANENTE (no cambia el comportamiento de HU-01)", async () => {
    await expect(handler({ ciudadanoId: "a/b", direccionUnica: DIR_ANA })).rejects.toThrow(PermanentError);
    expect(await Folder.countDocuments()).toBe(0);
  });
});

describe("FolderRepository.findByDireccionUnica()", () => {
  test("encuentra la carpeta del ciudadano destinatario", async () => {
    await handler({ ciudadanoId: ANA, direccionUnica: DIR_ANA });

    expect(await folderRepository.findByDireccionUnica(DIR_ANA)).toMatchObject({ ciudadanoId: ANA });
  });

  test("no distingue mayusculas ni espacios al buscar", async () => {
    await handler({ ciudadanoId: ANA, direccionUnica: DIR_ANA });

    for (const forma of [DIR_ANA.toUpperCase(), `  ${DIR_ANA}  `, DIR_ANA]) {
      expect(await folderRepository.findByDireccionUnica(forma)).toMatchObject({ ciudadanoId: ANA });
    }
  });

  test.each([["inexistente", "9999999999-aaaaaaaa@carpetacolombia.co"], ["vacia", ""], ["ausente", undefined], ["nula", null], ["que no es texto", 42], ["objeto de consulta", { $ne: null }]])(
    "devuelve null para una direccion %s (nunca una carpeta ajena)",
    async (_name, direccion) => {
      await handler({ ciudadanoId: ANA, direccionUnica: DIR_ANA });

      expect(await folderRepository.findByDireccionUnica(direccion)).toBeNull();
    }
  );

  test("una carpeta sin direccion no se puede encontrar buscando null", async () => {
    await handler({ ciudadanoId: BETO }); // carpeta sin direccion

    expect(await folderRepository.findByDireccionUnica(null)).toBeNull();
    expect(await Folder.countDocuments({ direccionUnica: null })).toBe(1); // existe, pero no es alcanzable por busqueda
  });
});

describe("La direccion unica es UNICA entre carpetas", () => {
  test("dos ciudadanos no pueden compartir direccion: el segundo conserva su carpeta pero NO se queda con la direccion ajena", async () => {
    await handler({ ciudadanoId: ANA, direccionUnica: DIR_ANA });

    await handler({ ciudadanoId: BETO, direccionUnica: DIR_ANA }); // anomalia: no deberia pasar (ms-identidad la garantiza unica)

    expect(await Folder.countDocuments({ direccionUnica: DIR_ANA })).toBe(1);
    expect((await Folder.findOne({ ciudadanoId: ANA }).lean()).direccionUnica).toBe(DIR_ANA); // la dueña la conserva
    expect(await Folder.findOne({ ciudadanoId: BETO }).lean()).toMatchObject({ noCertificados: 0, direccionUnica: null });
    // Un documento dirigido a esa direccion solo puede llegar a ANA, nunca a BETO.
    expect(await folderRepository.findByDireccionUnica(DIR_ANA)).toMatchObject({ ciudadanoId: ANA });
  });

  test("pero SI pueden coexistir muchas carpetas sin direccion (el indice es parcial, no sparse)", async () => {
    await handler({ ciudadanoId: ANA });
    await handler({ ciudadanoId: BETO });

    expect(await Folder.countDocuments()).toBe(2);
  });
});
