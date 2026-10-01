const ObjectStorageAdapter = require("../src/infrastructure/ObjectStorageAdapter");
const { PresignedUrlService, InvalidStorageKeyError } = require("../src/application/PresignedUrlService");

const ANA = "6aae9153b7655900026073f1";
const KEY = `ciudadanos/${ANA}/3f9c2ab7-1111-4222-8333-444455556666.pdf`;

/** Adaptador REAL (firma local con el SDK, sin red) contra un host publico de prueba. */
const storage = ObjectStorageAdapter.fromConfig({
  endpoint: "http://minio:9000",
  publicEndpoint: "https://files.example.net",
  region: "us-east-1",
  bucket: "carpeta-documentos",
  accessKeyId: "AKIATESTKEY",
  secretAccessKey: "test-secret-not-real", // secret-scan:allow -- valor falso de prueba
  forcePathStyle: true,
});

describe("PresignedUrlService.generate()", () => {
  test("crea una URL de LECTURA con expiracion de exactamente 15 minutos (900 s)", async () => {
    const now = new Date("2026-09-26T15:00:00Z");
    const service = new PresignedUrlService({ storage, ttlSeconds: 900, now: () => now });

    const { url, expiraEn } = await service.generate(KEY, ANA);

    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(expiraEn).toEqual(new Date("2026-09-26T15:15:00Z"));
  });

  test("la URL se firma para el host PUBLICO (el que GovCarpeta puede abrir), no el interno", async () => {
    const { url } = await new PresignedUrlService({ storage }).generate(KEY, ANA);

    expect(new URL(url).host).toBe("files.example.net");
    expect(url).toContain(`/carpeta-documentos/${KEY}`);
  });

  test("el adaptador rechaza vigencias mayores a 15 minutos (ADR-06)", async () => {
    await expect(storage.presignedGetUrl(KEY, 901)).rejects.toThrow(/entre 1 y 900/);
  });

  test.each([
    ["clave de otro ciudadano", `ciudadanos/6aae9153b7655900026073f2/x.pdf`],
    ["recorrido de rutas", `ciudadanos/${ANA}/../otro/x.pdf`],
    ["fuera del prefijo", "respaldos/dump.gz"],
    ["no es texto", { key: KEY }],
  ])("no firma una %s", async (_caso, key) => {
    await expect(new PresignedUrlService({ storage }).generate(key, ANA)).rejects.toBeInstanceOf(InvalidStorageKeyError);
  });
});
