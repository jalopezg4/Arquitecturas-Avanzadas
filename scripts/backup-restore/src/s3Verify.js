const { GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { sha256 } = require("./hash");
const { metadataEqual } = require("./metadataEqual");
const { listAllKeys } = require("./s3Backup");

/**
 * Verificacion INDEPENDIENTE de lo que `restoreObjects()` haya reportado: vuelve a consultar el destino de
 * verdad (lista, descarga, hashea) en vez de confiar en el resultado de la subida. Si un objeto no llego
 * -- por lo que sea: fallo de red al restaurar, fallo de integridad local, o cualquier otra causa -- aqui
 * aparece como FALTANTE, que es justo lo que debe convertir el resultado final en fallo de integridad.
 *
 * Compara: conjunto de claves, conteo, bytes totales, y por objeto: tamano, SHA-256, Content-Type y
 * metadata (como conjunto de pares clave-valor, no por igualdad de texto -- ver metadataEqual.js).
 */
async function verifyObjects(client, Bucket, manifestObjects) {
  const problems = [];
  const clavesEsperadas = manifestObjects.map((o) => o.key).sort();
  const clavesDestino = (await listAllKeys(client, Bucket)).sort();

  const faltantes = clavesEsperadas.filter((k) => !clavesDestino.includes(k));
  const sobrantes = clavesDestino.filter((k) => !clavesEsperadas.includes(k));
  if (faltantes.length) problems.push({ type: "faltante", keys: faltantes });
  if (sobrantes.length) problems.push({ type: "sobrante", keys: sobrantes });

  const bytesEsperados = manifestObjects.reduce((a, o) => a + o.size, 0);
  let bytesDestino = 0;

  for (const entry of manifestObjects) {
    if (!clavesDestino.includes(entry.key)) continue; // ya reportado como faltante arriba
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket, Key: entry.key }));
      bytesDestino += head.ContentLength;
      if (head.ContentLength !== entry.size) problems.push({ type: "tamano", key: entry.key, esperado: entry.size, real: head.ContentLength });

      const get = await client.send(new GetObjectCommand({ Bucket, Key: entry.key }));
      const buf = Buffer.from(await get.Body.transformToByteArray());
      const actualHash = sha256(buf);
      if (actualHash !== entry.sha256) problems.push({ type: "sha256", key: entry.key, esperado: entry.sha256, real: actualHash });
      if ((get.ContentType || null) !== (entry.contentType || null)) {
        problems.push({ type: "contentType", key: entry.key, esperado: entry.contentType, real: get.ContentType || null });
      }
      if (!metadataEqual(entry.metadata || {}, get.Metadata || {})) {
        problems.push({ type: "metadata", key: entry.key, esperado: entry.metadata, real: get.Metadata });
      }
    } catch (err) {
      problems.push({ type: "error-verificando", key: entry.key, error: err.message });
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    counts: { esperado: manifestObjects.length, destino: clavesDestino.length },
    bytes: { esperado: bytesEsperados, destino: bytesDestino },
  };
}

module.exports = { verifyObjects };
