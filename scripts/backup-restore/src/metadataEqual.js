/**
 * Compara dos objetos de metadata (S3 `Metadata` / cabeceras `x-amz-meta-*`) como CONJUNTOS de pares
 * clave-valor, sin depender del orden.
 *
 * Hallazgo experimental (prueba de MinIO previa a esta implementacion): MinIO no garantiza el orden de las
 * claves al devolver la metadata -- viaja como cabeceras HTTP, que tampoco lo garantizan -- asi que
 * `JSON.stringify(a) === JSON.stringify(b)` dio un falso negativo con las MISMAS dos claves en otro orden.
 * Esta funcion evita ese error.
 */
function metadataEqual(a = {}, b = {}) {
  const objA = a || {};
  const objB = b || {};
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.prototype.hasOwnProperty.call(objB, k) && objA[k] === objB[k]);
}

module.exports = { metadataEqual };
