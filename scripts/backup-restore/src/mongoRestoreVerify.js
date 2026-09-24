const fs = require("fs");
const { spawnMongoTool } = require("./dockerMongo");
const { captureFingerprint } = require("./mongoBackup");

// Las 5 bases logicas reales de los microservicios (docker-compose.yml). Si el destino YA tiene alguna,
// no es un Mongo temporal: es el de desarrollo (o, peor, uno real). Nunca se restaura encima sin --force.
const PROJECT_DB_NAMES = ["ms-identidad", "ms-documentos", "ms-notificaciones", "ms-interoperabilidad", "ms-comparticion"];

class MongoDestinationNotEmptyError extends Error {
  constructor(found) {
    super(
      `el Mongo destino YA tiene base(s) del proyecto (${found.join(", ")}): parece el Mongo de desarrollo/produccion, ` +
        "no un destino temporal. No se restaura sin --force."
    );
    this.name = "MongoDestinationNotEmptyError";
  }
}

async function _listDatabaseNames(mongoUri) {
  return new Promise((resolve, reject) => {
    const child = spawnMongoTool(["mongosh", "--quiet", "--eval", 'print(JSON.stringify(db.adminCommand("listDatabases").databases.map(d=>d.name)))', mongoUri]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`no se pudo consultar el destino: ${stderr.slice(-300)}`));
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (err) {
        reject(new Error(`no se pudo interpretar la lista de bases: ${err.message}`));
      }
    });
  });
}

/**
 * Comprueba que el DESTINO no tenga ya ninguna de las 5 bases reales del proyecto. Deliberadamente NO se
 * basa en el texto de la URI (adivinar por host/puerto/nombre es fragil y facil de burlar sin querer):
 * consulta que hay REALMENTE alli. Es la proteccion pedida para no restaurar por accidente sobre el Mongo
 * de desarrollo.
 */
async function assertPristineTarget(mongoUri, { force = false } = {}) {
  if (force) return;
  const dbs = await _listDatabaseNames(mongoUri);
  const found = PROJECT_DB_NAMES.filter((n) => dbs.includes(n));
  if (found.length > 0) throw new MongoDestinationNotEmptyError(found);
}

/** mongorestore --archive --gzip leyendo el archivo LOCAL via STDIN (nunca una ruta dentro del contenedor). */
function restoreFromFile(mongoUri, archiveFile) {
  return new Promise((resolve, reject) => {
    const child = spawnMongoTool(["mongorestore", `--uri=${mongoUri}`, "--archive", "--gzip"], { stdin: "pipe" });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ stderr }) : reject(new Error(`mongorestore salio con codigo ${code}: ${stderr.slice(-500)}`))));
    fs.createReadStream(archiveFile).pipe(child.stdin);
  });
}

/**
 * Compara dos huellas ({db: {col: {count, contentHash}}}) SIN hacer ninguna llamada de red: funcion pura,
 * facil de probar con datos de ejemplo. Detecta bases faltantes/sobrantes, colecciones faltantes/sobrantes
 * por base, y por coleccion: conteo Y contenido (via el hash BSON-aware) -- un conteo igual con contenido
 * distinto SI se detecta aqui, no solo un conteo distinto.
 */
function compareFingerprints(expected, actual) {
  const problems = [];
  const expectedDbs = Object.keys(expected).sort();
  const actualDbs = Object.keys(actual).sort();
  if (JSON.stringify(expectedDbs) !== JSON.stringify(actualDbs)) {
    problems.push({ type: "bases", esperado: expectedDbs, real: actualDbs });
  }

  for (const dbName of expectedDbs) {
    if (!actual[dbName]) continue; // ya reportado arriba como base faltante
    const expectedCols = Object.keys(expected[dbName]).sort();
    const actualCols = Object.keys(actual[dbName]).sort();
    if (JSON.stringify(expectedCols) !== JSON.stringify(actualCols)) {
      problems.push({ type: "colecciones", db: dbName, esperado: expectedCols, real: actualCols });
    }
    for (const col of expectedCols) {
      if (!actual[dbName][col]) continue;
      const e = expected[dbName][col];
      const a = actual[dbName][col];
      if (e.count !== a.count) problems.push({ type: "conteo", db: dbName, col, esperado: e.count, real: a.count });
      if (e.contentHash !== a.contentHash) problems.push({ type: "contenido", db: dbName, col, esperado: e.contentHash, real: a.contentHash });
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Vuelve a capturar la huella del DESTINO ya restaurado y la compara (compareFingerprints) contra la que quedo grabada en el manifest al momento del backup. */
async function verifyFingerprint(mongoUri, expected) {
  const actual = await captureFingerprint(mongoUri);
  return compareFingerprints(expected, actual);
}

module.exports = { assertPristineTarget, restoreFromFile, verifyFingerprint, compareFingerprints, MongoDestinationNotEmptyError, PROJECT_DB_NAMES };
