const crypto = require("crypto");

/**
 * Deriva un nombre de archivo local SEGURO a partir de una key de S3/MinIO. Nunca se usa la key cruda como
 * ruta: una key puede tener espacios, "/", caracteres reservados en Windows (: * ? " < > |) o texto Unicode
 * (verificado experimentalmente con una key real de prueba con tildes, parentesis, # y &), y aunque el SDK
 * la acepta sin problema como Key, no todo sistema de archivos la acepta igual como nombre de archivo.
 *
 * La relacion key <-> archivo local vive SOLO en el manifest (campo `localFile`); este nombre no se intenta
 * decodificar de vuelta a la key original.
 */
function safeLocalName(key) {
  const hash = crypto.createHash("sha1").update(key, "utf8").digest("hex");
  return `${hash}.bin`;
}

module.exports = { safeLocalName };
