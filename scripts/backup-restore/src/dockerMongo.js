const { spawn } = require("child_process");

// La MISMA imagen que ya usa el proyecto (docker-compose.yml: `mongo: image: mongo:7`) -- incluye
// mongodump/mongorestore/mongosh (verificado experimentalmente: /usr/bin/mongodump 100.18.0). No se
// introduce `mongodb/mongodb-database-tools` como contenedor auxiliar: no hace falta.
const MONGO_TOOLS_IMAGE = "mongo:7";

/**
 * Ejecuta mongodump/mongorestore/mongosh dentro de un contenedor mongo:7 DESECHABLE (`docker run --rm`),
 * nunca dentro de un contenedor con nombre fijo del docker-compose del proyecto: el script solo asume que
 * hay un Mongo alcanzable por URI, no un contenedor concreto (mas portable: funciona igual en desarrollo
 * local que en CI).
 *
 * `--add-host=host.docker.internal:host-gateway` permite que el contenedor alcance un Mongo publicado en
 * el host (Docker Desktop en Windows/Mac ya resuelve ese nombre solo; en Linux hace falta el flag -- se
 * pone siempre, no hace dano donde ya existe. Verificado experimentalmente en ambos casos).
 *
 * IMPORTANTE (compatibilidad Windows/Git Bash): nunca se pasa una ruta de archivo DENTRO del contenedor
 * como argumento (p. ej. `--archive=/tmp/x`). Eso es lo que dispara el problema de MSYS_NO_PATHCONV (Git
 * Bash reescribe rutas que empiezan por "/" antes de pasarlas a un binario nativo de Windows como
 * docker.exe). En su lugar, mongodump/mongorestore usan `--archive` SIN valor, que lee/escribe por
 * stdin/stdout -- gestionado enteramente por Node (`stdio: "pipe"`), sin ningun argumento de ruta.
 */
function spawnMongoTool(args, { stdin = "ignore" } = {}) {
  const dockerArgs = ["run", "--rm", ...(stdin === "pipe" ? ["-i"] : []), "--add-host=host.docker.internal:host-gateway", MONGO_TOOLS_IMAGE, ...args];
  return spawn("docker", dockerArgs, { stdio: [stdin, "pipe", "pipe"] });
}

module.exports = { spawnMongoTool, MONGO_TOOLS_IMAGE };
