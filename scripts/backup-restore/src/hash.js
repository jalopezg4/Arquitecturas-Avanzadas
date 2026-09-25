const crypto = require("crypto");

/** SHA-256 en hexadecimal de un Buffer. Es la unica huella que usa esta herramienta (Mongo y MinIO). */
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = { sha256 };
