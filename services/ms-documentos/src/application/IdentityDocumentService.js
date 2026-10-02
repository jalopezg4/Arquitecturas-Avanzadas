const logger = require("../tracing/logger");

const TITULO = "Cedula de ciudadania";
const ENTIDAD = "Registraduria Nacional del Estado Civil";

/**
 * HU-01, paso 13 de la arquitectura: al crear la carpeta de un ciudadano recien registrado se guarda su cedula firmada
 * por la Registraduria, como documento CERTIFICADO (no consume cuota, RNF-04).
 *
 * Idempotente: el evento `ciudadano.registrado` se entrega al menos una vez (y la reconciliacion de ms-identidad puede
 * reenviarlo). Antes de pedir el documento se busca si ya existe, y un indice unico parcial (ciudadanoId + origen
 * "registraduria") decide entre dos entregas simultaneas: nunca quedan dos cedulas.
 */
class IdentityDocumentService {
  constructor({ documentRepository, documentService, registraduria }) {
    this.documentRepository = documentRepository;
    this.documentService = documentService;
    this.registraduria = registraduria;
  }

  async issueSignedIdCard({ ciudadanoId, documento, nombre }) {
    if (await this.documentRepository.findIdCard(ciudadanoId)) return { created: false };

    // Si la Registraduria no responde, el error sube y el consumidor reintenta el evento (la carpeta ya existe).
    const cedula = await this.registraduria.signedIdCard({ documento, nombre });
    try {
      const { documentoId } = await this.documentService.upload({
        ciudadanoId,
        file: { buffer: cedula.buffer, mimetype: "application/pdf" },
        metadata: { titulo: TITULO, entidadAvaladora: ENTIDAD, fecha: cedula.emitidaEn.toISOString().slice(0, 10) },
        estado: "certificado",
        extra: { origen: "registraduria" },
        actor: { id: "registraduria", tipo: "sistema", delegated: false, action: "documento.recibir_cedula" },
      });
      logger.info("carpeta.cedula_guardada", { documentoId });
      return { created: true, documentoId };
    } catch (err) {
      // Otra entrega del mismo evento la guardo primero (indice unico): es justo lo que se queria.
      if (err && err.code === 11000 && (await this.documentRepository.findIdCard(ciudadanoId))) return { created: false };
      throw err;
    }
  }
}

module.exports = { IdentityDocumentService, TITULO, ENTIDAD };
