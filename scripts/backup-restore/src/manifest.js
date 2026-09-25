const fs = require("fs");
const path = require("path");

const MANIFEST_VERSION = 1;
const MANIFEST_FILE = "manifest.json";

/**
 * Manifest vacio con la forma que backup.js va completando. NUNCA debe llevar secretos (ni la URI de Mongo,
 * que podria incluir credenciales, ni las credenciales de S3): solo metadatos de lo respaldado.
 */
function newManifest({ bucket }) {
  return {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    minio: { bucket, objects: [], errors: [] },
    // null si se omitio con --skip-mongo o si el volcado fallo por completo (ver mongo.error)
    mongo: null,
  };
}

/** Campos minimos que TODO manifest valido debe tener, para poder restaurar/verificar con seguridad. */
function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") return ["el manifest no es un objeto"];
  if (manifest.version !== MANIFEST_VERSION) problems.push(`version de manifest desconocida: ${manifest.version}`);
  if (typeof manifest.generatedAt !== "string") problems.push("falta generatedAt");
  if (!manifest.minio || !Array.isArray(manifest.minio.objects)) {
    problems.push("falta minio.objects");
  } else {
    manifest.minio.objects.forEach((obj, i) => {
      for (const field of ["key", "size", "sha256", "localFile"]) {
        if (obj[field] === undefined) problems.push(`minio.objects[${i}] no tiene "${field}"`);
      }
    });
  }
  if (manifest.mongo) {
    for (const field of ["size", "sha256"]) {
      if (manifest.mongo[field] === undefined) problems.push(`mongo.${field} falta`);
    }
  }
  return problems;
}

function readManifest(dir) {
  const raw = fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8");
  return JSON.parse(raw);
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

module.exports = { MANIFEST_VERSION, MANIFEST_FILE, newManifest, validateManifest, readManifest, writeManifest };
