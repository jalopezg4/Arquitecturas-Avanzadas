const { PutObjectCommand, DeleteObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const ObjectStorageAdapter = require("../src/infrastructure/ObjectStorageAdapter");

const OWNER = "6aae9153b7655900026073f1";

function makeAdapter() {
  const sent = [];
  const client = { send: jest.fn(async (cmd) => { sent.push(cmd); return {}; }) };
  return { adapter: new ObjectStorageAdapter({ bucket: "carpeta-documentos", client }), client, sent };
}

describe("ObjectStorageAdapter.newKey()", () => {
  test("genera una clave unica por ciudadano bajo su propio prefijo", () => {
    const { adapter } = makeAdapter();

    const a = adapter.newKey(OWNER);
    const b = adapter.newKey(OWNER);

    expect(a).toMatch(new RegExp(`^ciudadanos/${OWNER}/[0-9a-f-]{36}\\.pdf$`));
    expect(a).not.toBe(b);
    expect(adapter.newKey("otro-ciudadano").startsWith("ciudadanos/otro-ciudadano/")).toBe(true);
  });

  test("no acepta ids que permitan salirse del prefijo (recorrido de rutas)", () => {
    const { adapter } = makeAdapter();
    for (const bad of ["../otro", "a/b", "", "a b", "x".repeat(65), undefined, 123]) {
      expect(() => adapter.newKey(bad)).toThrow(/ciudadanoId invalido/);
    }
  });

  test("miles de claves no colisionan", () => {
    const { adapter } = makeAdapter();
    const keys = new Set(Array.from({ length: 5000 }, () => adapter.newKey(OWNER)));
    expect(keys.size).toBe(5000);
  });
});

describe("ObjectStorageAdapter.put() / delete()", () => {
  test("sube el objeto al bucket con su clave, cuerpo y tipo", async () => {
    const { adapter, sent } = makeAdapter();
    const body = Buffer.from("%PDF-1.4 contenido");

    await adapter.put("ciudadanos/x/abc.pdf", body, "application/pdf");

    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[0].input).toEqual({ Bucket: "carpeta-documentos", Key: "ciudadanos/x/abc.pdf", Body: body, ContentType: "application/pdf" });
  });

  test("un fallo del storage se propaga (el servicio lo compensa)", async () => {
    const client = { send: jest.fn(async () => { throw new Error("S3 caido"); }) };
    await expect(new ObjectStorageAdapter({ bucket: "b", client }).put("k", Buffer.from("x"), "application/pdf")).rejects.toThrow("S3 caido");
  });

  test("borra el objeto por su clave", async () => {
    const { adapter, sent } = makeAdapter();
    await adapter.delete("ciudadanos/x/abc.pdf");
    expect(sent[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(sent[0].input).toEqual({ Bucket: "carpeta-documentos", Key: "ciudadanos/x/abc.pdf" });
  });
});

describe("ObjectStorageAdapter.presignedGetUrl() (ADR-06)", () => {
  // Cliente S3 REAL (sin red): firmar es un calculo local, asi que se comprueba la URL de verdad.
  const real = () =>
    new ObjectStorageAdapter({
      bucket: "carpeta-documentos",
      client: new S3Client({ region: "us-east-1", endpoint: "http://minio.interno:9000", forcePathStyle: true, credentials: { accessKeyId: "acceso-de-prueba", secretAccessKey: "secretoDePrueba" } }),
      presignClient: new S3Client({ region: "us-east-1", endpoint: "https://archivos.miapp.co", forcePathStyle: true, credentials: { accessKeyId: "acceso-de-prueba", secretAccessKey: "secretoDePrueba" } }),
    });

  test("firma para el endpoint PUBLICO (el que abre el navegador), no el interno", async () => {
    const url = await real().presignedGetUrl("ciudadanos/x/abc.pdf", 3600);

    expect(url.startsWith("https://archivos.miapp.co/carpeta-documentos/ciudadanos/x/abc.pdf?")).toBe(true);
    expect(url).not.toContain("minio.interno");
  });

  test("la URL expira en el plazo pedido y esta firmada", async () => {
    const url = new URL(await real().presignedGetUrl("ciudadanos/x/abc.pdf", 900));

    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rechaza vigencias fuera de politica: 0, negativa, no entera o mayor a 1 hora", async () => {
    for (const bad of [0, -1, 1.5, 3601, 86400, NaN, "3600", undefined]) {
      await expect(real().presignedGetUrl("k", bad)).rejects.toThrow(/entre 1 y 3600/);
    }
  });
});

describe("ObjectStorageAdapter -- falla RAPIDO si el storage no responde", () => {
  const net = require("net");

  // Un "S3" que acepta la conexion TCP y se queda callado: es lo que hace un storage colgado.
  async function startBlackHole() {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    // net.Server no tiene closeAllConnections(): hay que destruir los sockets a mano o close() espera para siempre.
    return { port: server.address().port, close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(r); }) };
  }

  test("put() contra un storage colgado se rinde en pocos segundos, no despues de minutos", async () => {
    const hole = await startBlackHole();
    try {
      const adapter = ObjectStorageAdapter.fromConfig({
        endpoint: `http://127.0.0.1:${hole.port}`, publicEndpoint: "", region: "us-east-1", bucket: "b", accessKeyId: "k", secretAccessKey: "s", forcePathStyle: true,
        connectTimeoutMs: 300, requestTimeoutMs: 400,
      });

      const started = Date.now();
      await expect(adapter.put("ciudadanos/x/a.pdf", Buffer.from("%PDF-1.4"), "application/pdf")).rejects.toThrow();

      expect(Date.now() - started).toBeLessThan(4000); // 2 intentos x ~400 ms + espera; nunca el minuto largo por defecto
    } finally {
      await hole.close();
    }
  }, 15000);

  test("el cliente se crea con maximo 2 intentos", async () => {
    const adapter = ObjectStorageAdapter.fromConfig({ endpoint: "http://localhost:9000", publicEndpoint: "", region: "us-east-1", bucket: "b", accessKeyId: "k", secretAccessKey: "s", forcePathStyle: true });
    expect(await adapter.client.config.maxAttempts()).toBe(2);
  });
});

describe("ObjectStorageAdapter.fromConfig()", () => {
  test("construye el adaptador con el bucket configurado", () => {
    const adapter = ObjectStorageAdapter.fromConfig({ endpoint: "http://localhost:9000", publicEndpoint: "", region: "us-east-1", bucket: "carpeta-documentos", accessKeyId: "k", secretAccessKey: "s", forcePathStyle: true });
    expect(adapter.bucket).toBe("carpeta-documentos");
    expect(adapter.presignClient).toBe(adapter.client); // sin endpoint publico se firma con el mismo cliente
  });

  test("con endpoint publico usa un cliente distinto para firmar", () => {
    const adapter = ObjectStorageAdapter.fromConfig({ endpoint: "http://minio:9000", publicEndpoint: "http://localhost:9000", region: "us-east-1", bucket: "b", accessKeyId: "k", secretAccessKey: "s", forcePathStyle: true });
    expect(adapter.presignClient).not.toBe(adapter.client);
  });
});
