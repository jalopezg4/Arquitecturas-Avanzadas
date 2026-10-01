const crypto = require("crypto");
const logger = require("../tracing/logger");

const IMPORTADOS = "transferencia.documentos_importados";

// Tipos que se aceptan por su FIRMA real (el Content-Type del otro operador no es confiable). El servicio guarda PDF;
// se admiten tambien imagenes porque otros operadores del curso pueden custodiar escaneos.
const FIRMAS = [
  { mime: "application/pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];
const EXTENSION = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const texto = (v, fallback) => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) : fallback);

function fecha(v, now) {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(ms) || ms > now.getTime() + 24 * 3600 * 1000 ? now : new Date(ms);
}

/**
 * HU-05c, lado DESTINO en ms-documentos: importa los documentos de un ciudadano que llega desde otro operador.
 *
 *   transferencia.importar_documentos  -> descarga cada URL (SSRF, tamano, firma real, huella si viene), la guarda en
 *                                         NUESTRO storage y crea el documento en su carpeta; responde
 *                                         `transferencia.documentos_importados` {ok, importados, motivo}
 *   transferencia.revertir_importacion -> borra lo importado por esa transferencia (el registro del ciudadano fallo)
 *
 * Es TODO o NADA: si un documento no se puede traer, se deshace lo ya importado y se responde ok:false (el origen no
 * debe borrar nada si el destino no tiene todo). Idempotente por (transferencia, clave): una reentrega no duplica.
 */
class TransferImportService {
  constructor({ documentRepository, folderRepository, storage, fetcher, eventPublisher, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    this.documentRepository = documentRepository;
    this.folderRepository = folderRepository;
    this.storage = storage;
    this.fetcher = fetcher;
    this.eventPublisher = eventPublisher;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  async import({ transferenciaId, ciudadanoId, documento, direccionUnica, documentos }) {
    const result = await this._import({ transferenciaId, ciudadanoId, documento, direccionUnica, documentos });
    // Si el broker no confirma, se lanza: la orden se reintenta y, por la idempotencia, responde lo mismo.
    await withTimeout(this.eventPublisher.publish(IMPORTADOS, { transferenciaId, ciudadanoId, ...result }), this.eventPublishTimeoutMs);
    return result;
  }

  async _import({ transferenciaId, ciudadanoId, documento, direccionUnica, documentos }) {
    await this.folderRepository.ensure(ciudadanoId, direccionUnica, documento);
    const existentes = new Map((await this.documentRepository.findByTransfer(transferenciaId)).map((d) => [d.claveTransferencia, d]));
    try {
      for (const item of documentos) {
        if (existentes.has(item.clave)) continue; // ya importado en una entrega anterior
        await this._importOne({ transferenciaId, ciudadanoId, item });
      }
    } catch (err) {
      if (err && err.transient) throw err; // red / 5xx del origen: se reintenta la orden completa (lo ya traido se conserva)
      logger.warn("transferencia.importacion_fallida", { transferenciaId, motivo: err.message });
      await this.revert({ transferenciaId, ciudadanoId });
      return { ok: false, importados: 0, motivo: String(err.message || "error").slice(0, 200) };
    }
    // Los temporales ocupan cupo aunque superen el maximo de este operador: al llegar no se pierde nada, pero el
    // ciudadano no podra cargar mas temporales hasta bajar del limite. Se cuentan TODOS los de la transferencia (no
    // solo los de esta entrega) y por id: un reintento tras un corte a mitad no deja ninguno sin contar.
    const importados = await this.documentRepository.findByTransfer(transferenciaId);
    await this.folderRepository.addNonCertified(ciudadanoId, importados.filter((d) => d.estado === "temporal").map((d) => d._id));
    const total = importados.length;
    logger.info("transferencia.documentos_importados", { transferenciaId, importados: total });
    return { ok: true, importados: total };
  }

  async _importOne({ transferenciaId, ciudadanoId, item }) {
    const { buffer } = await this.fetcher.fetch(item.url);
    if (!buffer.length) throw new Error(`${item.clave}: el documento esta vacio`);
    const firma = FIRMAS.find((f) => f.test(buffer));
    if (!firma) throw new Error(`${item.clave}: tipo de archivo no admitido`);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    if (item.sha256 && String(item.sha256).toLowerCase() !== sha256) throw new Error(`${item.clave}: la huella no coincide con la declarada`);

    const key = this.storage.newKey(ciudadanoId).replace(/\.pdf$/, `.${EXTENSION[firma.mime]}`);
    await this.storage.put(key, buffer, firma.mime);
    try {
      return await this.documentRepository.create({
        ciudadanoId,
        titulo: texto(item.titulo, "Documento transferido"),
        entidadAvaladora: texto(item.entidadAvaladora, "No informada"),
        fecha: fecha(item.fecha, this.now()),
        // Lo declara el operador origen (participante del ecosistema). Sin metadato, se asume no certificado.
        estado: item.estado === "certificado" ? "certificado" : "temporal",
        storageKey: key,
        mimeType: firma.mime,
        tamanoBytes: buffer.length,
        sha256,
        origen: "transferencia",
        transferenciaOrigenId: transferenciaId,
        claveTransferencia: item.clave,
        // No se avisa documento por documento: el ciudadano recibe la bienvenida al quedar registrado.
        eventoPublicado: true,
      });
    } catch (err) {
      await this.storage.delete(key).catch(() => {});
      if (err && err.code === 11000) return (await this.documentRepository.findByTransfer(transferenciaId)).find((d) => d.claveTransferencia === item.clave);
      throw err;
    }
  }

  /** Deshace la importacion de una transferencia: objetos, documentos y la carpeta si quedo vacia. Idempotente. */
  async revert({ transferenciaId, ciudadanoId }) {
    const docs = await this.documentRepository.findByTransfer(transferenciaId);
    for (const d of docs) await this.storage.delete(d.storageKey);
    await this.documentRepository.deleteByIds(docs.map((d) => d._id));
    for (const d of docs) await this.folderRepository.releaseNonCertified(ciudadanoId, d._id);
    const remaining = (await this.documentRepository.listAllByOwner(ciudadanoId, 1)).length;
    await this.folderRepository.deleteIfEmpty(ciudadanoId, remaining);
    if (docs.length) logger.info("transferencia.importacion_revertida", { transferenciaId, documentos: docs.length });
  }
}

module.exports = { TransferImportService, IMPORTADOS };
