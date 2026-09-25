#!/usr/bin/env node
/**
 * HT-03 -- siembra el dataset minimo y deterministico para poder ejecutar
 *   GET /api/v1/citizens/ht03-loadtest-0001/documents?page=1&pageSize=10
 * durante la prueba de carga: una carpeta y 12 documentos (2 paginas a pageSize=10) para el ciudadano
 * sintetico `ht03-loadtest-0001`. No es un ciudadano real ni pasa por HU-01 (no toca GovCarpeta).
 *
 * Reutiliza el MISMO acceso a MongoDB que ya usa ms-documentos: se requieren directamente los modelos
 * Mongoose reales del servicio (`Document`, `Folder`, sin duplicar el schema aqui) y se conecta con la
 * MISMA instancia de mongoose con la que esos modelos fueron compilados (`Model.base`) -- asi cualquier
 * validacion/indice que ms-documentos ya define se respeta automaticamente, sin reimplementar nada.
 *
 * Idempotente: cada documento se identifica por un `storageKey` deterministico (`ht03-loadtest/doc-NN.pdf`)
 * y se escribe con upsert (`$setOnInsert`), igual que `FolderRepository.ensure()` -- correr este script
 * varias veces no duplica nada.
 *
 * Uso:
 *   node seed-test-data.js
 *   MONGO_URI=mongodb://localhost:27017/ms-documentos node seed-test-data.js
 */
const path = require("path");

const Document = require(path.join("..", "..", "services", "ms-documentos", "src", "domain", "Document"));
const Folder = require(path.join("..", "..", "services", "ms-documentos", "src", "domain", "Folder"));

const CIUDADANO_ID = "ht03-loadtest-0001";
const TOTAL_DOCUMENTOS = 12; // > pageSize (10): la primera pagina de la prueba siempre trae 10 y total 12, real y estable

function buildDocumentos() {
  const docs = [];
  for (let i = 1; i <= TOTAL_DOCUMENTOS; i++) {
    const n = String(i).padStart(2, "0");
    docs.push({
      storageKey: `ht03-loadtest/doc-${n}.pdf`, // clave deterministica -- NUNCA se sube a MinIO, este endpoint no lo necesita (list() no toca el storage)
      ciudadanoId: CIUDADANO_ID,
      titulo: `Documento de prueba HT-03 #${n}`,
      entidadAvaladora: "Entidad de prueba HT-03",
      fecha: new Date(Date.UTC(2026, 0, i)), // 2026-01-01, 02, 03... deterministico, no depende de "ahora"
      estado: "temporal",
      mimeType: "application/pdf",
      tamanoBytes: 102400,
      sha256: require("crypto").createHash("sha256").update(`ht03-loadtest-doc-${n}`).digest("hex"),
      origen: "ciudadano",
    });
  }
  return docs;
}

async function seed(mongoUri) {
  const mongoose = Document.base; // misma instancia de mongoose con la que ms-documentos compilo estos modelos
  await mongoose.connect(mongoUri);

  await Folder.updateOne({ ciudadanoId: CIUDADANO_ID }, { $setOnInsert: { noCertificados: 0 } }, { upsert: true });

  const documentos = buildDocumentos();
  let creados = 0;
  let yaExistian = 0;
  for (const doc of documentos) {
    const res = await Document.updateOne({ storageKey: doc.storageKey }, { $setOnInsert: doc }, { upsert: true });
    if (res.upsertedCount > 0) creados++;
    else yaExistian++;
  }

  const total = await Document.countDocuments({ ciudadanoId: CIUDADANO_ID });
  return { creados, yaExistian, total };
}

if (require.main === module) {
  const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/ms-documentos";
  seed(mongoUri)
    .then(async (result) => {
      console.log(`HT-03 seed OK -- ciudadano=${CIUDADANO_ID} creados=${result.creados} ya_existian=${result.yaExistian} total_documentos=${result.total}`);
      await Document.base.disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("HT-03 seed FALLO:", err.message);
      await Document.base.disconnect().catch(() => {});
      process.exit(1);
    });
}

module.exports = { seed, CIUDADANO_ID, TOTAL_DOCUMENTOS, buildDocumentos };
