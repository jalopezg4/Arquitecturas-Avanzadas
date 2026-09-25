const { execFileSync } = require("child_process");
const path = require("path");

// Nombre FIJO de la carpeta dentro del .tar.gz. Quien empaqueta (backup.js) debe crear su directorio de
// trabajo con este mismo nombre (dentro de un padre unico de mkdtemp): asi el .tar.gz siempre contiene
// "backup-store/", nunca un nombre aleatorio, y restore-verify.js sabe exactamente donde buscar
// manifest.json despues de desempaquetar.
const INNER_DIR = "backup-store";

/**
 * Convierte una ruta de Windows con unidad (`C:\Users\x`) a la forma MSYS/Cygwin que entiende el `tar` de
 * Git Bash (`/c/Users/x`). En cualquier otro sistema operativo es un no-op.
 *
 * Bug real encontrado al probar esto de punta a punta (no una precaucion teorica): el GNU tar que trae
 * Git Bash interpreta un ":" en un argumento de ruta como sintaxis de host remoto para cintas
 * (`usuario@host:archivo`), asi que `C:\Users\...\backup.tar.gz` lo confunde con un host llamado "C" --
 * `--force-local` corrige eso SOLO para el argumento del archivo (`-f`), pero el mismo problema aparece,
 * de forma distinta, con `-C <directorio>` al EXTRAER (el empaquetado con `-C` funciona bien; el
 * desempaquetado no, incluso con `--force-local` y probando varios ordenes de argumentos). Convertir la
 * ruta ANTES de pasarla es la solucion que de verdad funciona en ambos casos, verificada con una prueba de
 * punta a punta real (pack + unpack con rutas `C:\...`).
 */
function toTarPath(p) {
  if (process.platform !== "win32") return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p;
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/**
 * Empaqueta/desempaqueta el `.tar.gz` del backup con el `tar` del SISTEMA (preinstalado en Linux/CI y en
 * Git Bash de Windows -- verificado: GNU tar 1.35). No se agrega una dependencia npm de compresion: `tar`
 * ya esta disponible en todo entorno donde este proyecto corre, y usarlo via `execFileSync` (array de
 * argumentos, sin shell) evita cualquier problema de citado de rutas.
 *
 * Esto NO invoca Docker en ningun momento, asi que el problema de MSYS_NO_PATHCONV (que solo afecta a
 * argumentos de ruta pasados a un binario NATIVO de Windows como docker.exe, y se corrige desactivando esa
 * traduccion) no aplica aqui -- aqui el problema es el opuesto (`tar` es el binario MSYS, y necesita rutas
 * en SU propio formato), y se resuelve con `toTarPath()`, no con esa variable de entorno.
 *
 * @param {string} sourceDir  debe llamarse exactamente INNER_DIR (backup-store); ver nota arriba.
 */
function pack(sourceDir, outFile) {
  const parent = path.dirname(sourceDir);
  const base = path.basename(sourceDir);
  if (base !== INNER_DIR) throw new Error(`archive.pack: el directorio de origen debe llamarse "${INNER_DIR}" (es "${base}")`);
  execFileSync("tar", ["--force-local", "-czf", toTarPath(outFile), "-C", toTarPath(parent), INNER_DIR], { stdio: "pipe" });
}

/** Desempaqueta en `destDir` y devuelve la ruta real donde queda el contenido (`<destDir>/backup-store`). */
function unpack(archiveFile, destDir) {
  execFileSync("tar", ["--force-local", "-xzf", toTarPath(archiveFile), "-C", toTarPath(destDir)], { stdio: "pipe" });
  return path.join(destDir, INNER_DIR);
}

module.exports = { pack, unpack, toTarPath, INNER_DIR };
