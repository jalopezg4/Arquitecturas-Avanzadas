/**
 * Adaptador de la Registraduria Nacional del Estado Civil (HU-01, pasos 4-5 de la arquitectura): antes de afiliar a
 * un ciudadano se confirma que la identidad corresponde a una persona existente y con cedula vigente.
 *
 * La Registraduria no expone un servicio accesible para el proyecto (supuesto 9.4 del documento de arquitectura), asi
 * que la implementacion es SIMULADA con un contrato equivalente al de un servicio real:
 *
 *   verifyIdentity({ documento, nombre }) -> { estado: "vigente" | "no_encontrada" | "cancelada" }
 *   lanza RegistraduriaNoDisponibleError si el servicio no responde
 *
 * Reemplazarla por un cliente real no toca la saga: basta con otra clase con el mismo metodo.
 *
 * Comportamiento simulado: toda cedula es vigente, salvo las listadas en `noEncontrados` (persona inexistente) y
 * `cancelados` (cedula cancelada, p. ej. por fallecimiento), configurables con REGISTRADURIA_SIMULADA_NO_ENCONTRADOS
 * y REGISTRADURIA_SIMULADA_CANCELADOS para poder demostrar los flujos de rechazo. `noDisponible: true` simula una
 * caida del servicio.
 */
class RegistraduriaNoDisponibleError extends Error {
  constructor(message = "la Registraduria no respondio") {
    super(message);
    this.name = "RegistraduriaNoDisponibleError";
  }
}

const ESTADOS_IDENTIDAD = ["vigente", "no_encontrada", "cancelada"];

class SimulatedRegistraduriaClient {
  constructor({ noEncontrados = [], cancelados = [], noDisponible = false } = {}) {
    this.noEncontrados = new Set(noEncontrados.map(String));
    this.cancelados = new Set(cancelados.map(String));
    this.noDisponible = noDisponible;
  }

  async verifyIdentity({ documento }) {
    if (this.noDisponible) throw new RegistraduriaNoDisponibleError();
    const id = String(documento);
    if (this.noEncontrados.has(id)) return { estado: "no_encontrada" };
    if (this.cancelados.has(id)) return { estado: "cancelada" };
    return { estado: "vigente" };
  }
}

module.exports = { SimulatedRegistraduriaClient, RegistraduriaNoDisponibleError, ESTADOS_IDENTIDAD };
