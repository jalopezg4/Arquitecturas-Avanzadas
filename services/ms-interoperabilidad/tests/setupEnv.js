// Los tests no deben llenar la consola de lineas de log; los que verifican logs usan logger.setSink().
process.env.LOG_SILENT = "1";

// mongodb-memory-server descarga ~500 MB de binario por servicio. En desarrollo local se reutiliza la cache de
// ms-identidad si ya esta ahi (en CI cada servicio descarga la suya).
const fs = require("fs");
const path = require("path");
const shared = path.resolve(__dirname, "..", "..", "ms-identidad", "node_modules", ".cache", "mongodb-memory-server");
if (!process.env.MONGOMS_DOWNLOAD_DIR && fs.existsSync(shared)) process.env.MONGOMS_DOWNLOAD_DIR = shared;
