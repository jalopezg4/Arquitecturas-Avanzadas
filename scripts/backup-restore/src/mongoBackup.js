const fs = require("fs");
const { spawnMongoTool } = require("./dockerMongo");
const { sha256 } = require("./hash");

/**
 * mongodump --archive --gzip contra `mongoUri`, escribiendo el resultado por STDOUT directo a `outFile`
 * (nunca una ruta dentro del contenedor). Respalda la instancia COMPLETA (sin --db): en este proyecto una
 * sola instancia Mongo contiene las 5 bases logicas de los microservicios (ms-identidad, ms-documentos,
 * ms-notificaciones, ms-interoperabilidad, ms-comparticion), y mongodump sin filtro las captura todas de
 * una vez, coherente con que es una sola instancia fisica (docker-compose.yml: un solo `mongo:`, un solo
 * volumen `mongo-data`). No se respalda PostgreSQL (no existe en el alcance de este repositorio) ni
 * RabbitMQ (mensajeria en transito, no el registro durable de datos).
 */
function dumpToFile(mongoUri, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawnMongoTool(["mongodump", `--uri=${mongoUri}`, "--archive", "--gzip"]);
    const out = fs.createWriteStream(outFile);
    let stderr = "";
    child.stdout.pipe(out);
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      out.close(() => {
        if (code === 0) resolve({ stderr });
        else reject(new Error(`mongodump salio con codigo ${code}: ${stderr.slice(-500)}`));
      });
    });
  });
}

// Eval de mongosh: recorre TODAS las bases no-sistema, y para cada coleccion junta el conteo y el EJSON
// (BSON-aware: preserva Date/BinData/NumberDecimal/etc, no solo el texto) de cada documento, ordenado por
// _id para que el resultado sea determinista. mongosh no expone `crypto`: el hash se calcula en Node, no
// aqui (ver mas abajo). Un solo `print(JSON.stringify(...))` -> una linea de stdout, facil de capturar.
const FINGERPRINT_EVAL = `
const dbNames = db.adminCommand("listDatabases").databases.map(d=>d.name).filter(n=>!["admin","local","config"].includes(n)).sort();
const out = {};
for (const dbName of dbNames) {
  const sdb = db.getSiblingDB(dbName);
  const cols = sdb.getCollectionNames().sort();
  out[dbName] = {};
  for (const col of cols) {
    const docs = sdb.getCollection(col).find().sort({_id:1}).toArray();
    out[dbName][col] = { count: docs.length, ejson: docs.map(d => EJSON.stringify(d)) };
  }
}
print(JSON.stringify(out));
`.trim();

/**
 * Captura una "huella" del contenido: por base y coleccion, el conteo y un hash SHA-256 del EJSON
 * concatenado de sus documentos (BSON-aware, no solo texto plano). Se guarda en el manifest y permite
 * verificar la restauracion SIN necesitar que el Mongo de origen siga corriendo en ese momento -- backup,
 * restore y verify pueden ocurrir en momentos/lugares distintos.
 *
 * SIMPLIFICACION DOCUMENTADA (ver README, seccion "limitaciones"): se materializan las colecciones
 * completas en memoria dentro de mongosh y se transmiten enteras por stdout para hashear del lado de Node.
 * Para el volumen de datos de este proyecto (curso, desarrollo local) es razonable y ya fue validado
 * experimentalmente con multiples bases/colecciones y tipos BSON variados (Date, BinData, NumberDecimal).
 * A escala de produccion real con colecciones grandes haria falta un hashing incremental (p. ej. via
 * aggregation pipeline) en vez de traer cada documento completo a mongosh y luego a Node.
 */
async function captureFingerprint(mongoUri) {
  return new Promise((resolve, reject) => {
    const child = spawnMongoTool(["mongosh", "--quiet", "--eval", FINGERPRINT_EVAL, mongoUri]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`mongosh (huella) salio con codigo ${code}: ${stderr.slice(-500)}`));
      try {
        const raw = JSON.parse(stdout.trim());
        const withHashes = {};
        for (const [dbName, cols] of Object.entries(raw)) {
          withHashes[dbName] = {};
          for (const [colName, info] of Object.entries(cols)) {
            withHashes[dbName][colName] = { count: info.count, contentHash: sha256(Buffer.from(info.ejson.join("\u0001"), "utf8")) };
          }
        }
        resolve(withHashes);
      } catch (err) {
        reject(new Error(`no se pudo interpretar la salida de mongosh: ${err.message}\nsalida: ${stdout.slice(0, 300)}`));
      }
    });
  });
}

module.exports = { dumpToFile, captureFingerprint, FINGERPRINT_EVAL };
