const fs = require("fs");
const path = require("path");
const { ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { sha256 } = require("./hash");
const { safeLocalName } = require("./safeLocalName");

/**
 * Lista TODAS las claves del bucket, siguiendo `ContinuationToken` hasta agotarlo. El bucle es el mismo
 * con 5 objetos que con 100000: solo cambia cuantas vueltas da (validado forzando `MaxKeys` bajo en la
 * prueba experimental para ejercitar varias paginas con pocos objetos).
 */
async function listAllKeys(client, Bucket) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
    for (const o of res.Contents || []) keys.push(o.Key);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

/**
 * Descarga cada objeto, calcula su SHA-256 y lo guarda con un nombre local SEGURO (derivado por hash de la
 * key, nunca la key cruda -- ver safeLocalName.js). Preserva `ContentType` y `Metadata`.
 *
 * Un fallo INDIVIDUAL (p. ej. el objeto desaparecio entre `list` y `get`, una carrera real validada
 * experimentalmente) se registra en `errors` y NO detiene el backup: se sigue con los demas objetos. El
 * backup nunca aparenta estar completo si no lo esta: los errores quedan en el manifest, no se ocultan.
 */
async function backupObjects(client, Bucket, objectsDir) {
  fs.mkdirSync(objectsDir, { recursive: true });
  const keys = await listAllKeys(client, Bucket);
  const objects = [];
  const errors = [];

  for (const key of keys) {
    try {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      const buf = Buffer.from(await res.Body.transformToByteArray());
      const localFile = safeLocalName(key);
      fs.writeFileSync(path.join(objectsDir, localFile), buf);
      objects.push({
        key,
        size: buf.length,
        sha256: sha256(buf),
        contentType: res.ContentType || null,
        metadata: res.Metadata || {},
        localFile,
      });
    } catch (err) {
      errors.push({ key, error: err.name || err.message });
    }
  }
  return { objects, errors, totalKeys: keys.length };
}

module.exports = { listAllKeys, backupObjects };
