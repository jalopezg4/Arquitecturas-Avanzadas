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

module.exports = { CarpetaEnTransferenciaError };
