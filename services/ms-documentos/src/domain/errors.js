/**
 * HU-05c: la carpeta del ciudadano esta en SOLO LECTURA porque se esta transfiriendo a otro operador. Mientras tanto
 * nadie (ni el ciudadano, ni una entidad emisora) puede escribir en ella: lo que se agregue no viajaria al destino.
 */
class CarpetaEnTransferenciaError extends Error {
  constructor() {
    super("la carpeta esta en transferencia a otro operador y no admite cambios");
    this.name = "CarpetaEnTransferenciaError";
  }
}

/** El documento no existe (o su id no tiene forma valida): para quien pregunta es lo mismo. -> 404 */
class DocumentoNoEncontradoError extends Error {
  constructor() {
    super("documento no encontrado");
    this.name = "DocumentoNoEncontradoError";
  }
}

/** El documento es de otro ciudadano (queda en la bitacora como `no_es_dueno`). -> 403 */
class DocumentoAjenoError extends Error {
  constructor(message = "solo el dueno del documento puede acceder a el") {
    super(message);
    this.name = "DocumentoAjenoError";
  }
}

module.exports = { CarpetaEnTransferenciaError, DocumentoNoEncontradoError, DocumentoAjenoError };
