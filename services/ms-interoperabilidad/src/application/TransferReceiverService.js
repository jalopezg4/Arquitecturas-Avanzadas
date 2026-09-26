const crypto = require("crypto");
const mongoose = require("mongoose");
const logger = require("../tracing/logger");
const { assertSafeTransferUrl } = require("../security/transferUrl");

class PedidoInvalidoError extends Error {
  constructor(message) {
    super(message);
    this.name = "PedidoInvalidoError";
  }
}
class CiudadanoYaAfiliadoError extends Error {
  constructor() {
    super("el ciudadano ya esta afiliado a este operador o tiene otra transferencia en curso");
    this.name = "CiudadanoYaAfiliadoError";
  }
}

const IMPORTAR = "transferencia.importar_documentos";
const REVERTIR = "transferencia.revertir_importacion";
const REGISTRAR = "transferencia.registrar_ciudadano";
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const optText = (v, max) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

/**
 * HU-05c, lado DESTINO: un ciudadano llega desde otro operador (`POST /api/transferCitizen`, protocolo acordado).
 *
 *   1. receive()               valida el pedido (URLs de un tercero: politica SSRF), registra la transferencia y
 *                              ordena a ms-documentos importar los documentos -> 202 al origen
 *   2. onDocumentsImported     ok -> ordena a ms-identidad crear y afiliar al ciudadano; no -> rechazar
 *   3. onCitizenRegistered     ok -> confirmar 1 al origen; no -> revertir lo importado y confirmar 0
 *   4. _confirm()              POST al confirmAPI del origen {id, req_status}; se reintenta desde el barrido
 *
 * El origen solo borra sus datos cuando le confirmamos 1, y solo le confirmamos 1 cuando el ciudadano ya esta completo
 * aqui (documentos importados + afiliado en GovCarpeta con nuestro operador).
 */
class TransferReceiverService {
  constructor({ transferRepository, citizenRepository, peerClient, eventPublisher, auditLogger, urlPolicy = {}, maxDocuments = 500, stepTimeoutMs = 2 * 60 * 1000, maxConfirmAttempts = 5, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    this.transfers = transferRepository;
    this.citizens = citizenRepository;
    this.peer = peerClient;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.urlPolicy = urlPolicy;
    this.maxDocuments = maxDocuments;
    this.stepTimeoutMs = stepTimeoutMs;
    this.maxConfirmAttempts = maxConfirmAttempts;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  _later(ms) {
    return new Date(this.now().getTime() + ms);
  }

  async _publish(routingKey, payload) {
    await withTimeout(this.eventPublisher.publish(routingKey, payload), this.eventPublishTimeoutMs);
  }

  // ---------------------------------------------------------------- 1. recibir

  _parse(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new PedidoInvalidoError("el cuerpo debe ser un objeto");
    const id = typeof body.id === "string" && /^\d{1,15}$/.test(body.id) ? Number(body.id) : body.id;
    if (!Number.isSafeInteger(id) || id <= 0) throw new PedidoInvalidoError("id invalido");
    if (!text(body.citizenName, 200)) throw new PedidoInvalidoError("citizenName invalido");
    if (typeof body.citizenEmail !== "string" || body.citizenEmail.length > 200 || !EMAIL_RE.test(body.citizenEmail)) throw new PedidoInvalidoError("citizenEmail invalido");
    let confirmApi;
    try {
      confirmApi = assertSafeTransferUrl(body.confirmAPI, this.urlPolicy);
    } catch (err) {
      throw new PedidoInvalidoError(`confirmAPI invalida: ${err.reason || err.message}`);
    }

    const urls = body.urlDocuments === undefined ? {} : body.urlDocuments;
    if (!urls || typeof urls !== "object" || Array.isArray(urls)) throw new PedidoInvalidoError("urlDocuments debe ser un objeto");
    const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {};
    const documentos = [];
    for (const [key, value] of Object.entries(urls)) {
      if (!KEY_RE.test(key)) throw new PedidoInvalidoError("urlDocuments tiene una llave invalida");
      const list = Array.isArray(value) ? value : [value];
      list.forEach((raw, i) => {
        let url;
        try {
          url = assertSafeTransferUrl(raw, this.urlPolicy);
        } catch (err) {
          throw new PedidoInvalidoError(`urlDocuments.${key}: ${err.reason || err.message}`);
        }
        const meta = metadata[key] && typeof metadata[key] === "object" ? metadata[key] : {};
        documentos.push({
          clave: list.length > 1 ? `${key}_${i + 1}` : key,
          url,
          titulo: optText(meta.titulo, 200),
          entidadAvaladora: optText(meta.entidadAvaladora, 200),
          fecha: optText(meta.fecha, 40),
          estado: meta.estado === "certificado" ? "certificado" : meta.estado === "temporal" ? "temporal" : null,
          sha256: typeof meta.sha256 === "string" && /^[0-9a-f]{64}$/i.test(meta.sha256) ? meta.sha256.toLowerCase() : null,
        });
      });
      if (documentos.length > this.maxDocuments) throw new PedidoInvalidoError(`se admiten maximo ${this.maxDocuments} documentos`);
    }
    return {
      documento: id,
      nombre: body.citizenName.trim(),
      correo: body.citizenEmail.trim(),
      confirmApi,
      documentos,
      direccionUnica: optText(body.direccionUnica, 200),
      direccion: optText(body.citizenAddress, 300),
    };
  }

  async receive(body) {
    const req = this._parse(body);
    const huella = crypto.createHash("sha256").update(JSON.stringify([req.documento, req.confirmApi, req.documentos.map((d) => d.url)])).digest("hex");

    const enCurso = await this.transfers.findActive("entrante", { documento: req.documento });
    if (enCurso) {
      // Reintento del origen (timeout de red): misma transferencia, misma respuesta. Otro pedido distinto: conflicto.
      if (enCurso.huellaPedido === huella) return { transferenciaId: String(enCurso._id), estado: enCurso.estado, repetida: true };
      throw new CiudadanoYaAfiliadoError();
    }
    if (await this.citizens.findByDocumento(req.documento)) throw new CiudadanoYaAfiliadoError();

    let t;
    try {
      t = await this.transfers.create({
        tipo: "entrante",
        estado: "importando",
        // El id que tendra el ciudadano AQUI: lo usan ms-documentos (carpeta) y ms-identidad (registro).
        ciudadanoId: new mongoose.Types.ObjectId().toString(),
        documento: req.documento,
        nombre: req.nombre,
        correo: req.correo,
        direccion: req.direccion,
        direccionUnica: req.direccionUnica,
        documentos: req.documentos,
        confirmApi: req.confirmApi,
        huellaPedido: huella,
        iniciadaEn: this.now(),
        revisarEn: this._later(this.stepTimeoutMs),
      });
    } catch (err) {
      if (err && err.name === "TransferConflictError") throw new CiudadanoYaAfiliadoError();
      throw err;
    }
    await this._audit(t, "transferencia.recibir", "exito");
    await this._publish(IMPORTAR, this._importOrder(t)).catch((err) => logger.error("transferencia.orden_no_publicada", { transferenciaId: String(t._id), note: "la reenvia el barrido", err }));
    return { transferenciaId: String(t._id), estado: t.estado };
  }

  _importOrder(t) {
    return { transferenciaId: String(t._id), ciudadanoId: t.ciudadanoId, documento: t.documento, direccionUnica: t.direccionUnica, documentos: t.documentos };
  }

  _registerOrder(t) {
    return { transferenciaId: String(t._id), ciudadanoId: t.ciudadanoId, documento: t.documento, nombre: t.nombre, correo: t.correo, direccion: t.direccion, direccionUnica: t.direccionUnica };
  }

  // ---------------------------------------------------------------- 2 y 3. respuestas de nuestros servicios

  async onDocumentsImported({ transferenciaId, ok, motivo }) {
    const t = await this.transfers.findById(transferenciaId);
    if (!t || t.tipo !== "entrante" || t.estado !== "importando") return { ignored: true };
    if (!ok) return this._reject(t, `importacion: ${motivo || "fallida"}`);
    const next = await this.transfers.transition(t._id, "importando", "registrando", { revisarEn: this._later(this.stepTimeoutMs) });
    if (!next) return { ignored: true };
    await this._publish(REGISTRAR, this._registerOrder(next)).catch((err) => logger.error("transferencia.orden_no_publicada", { transferenciaId, note: "la reenvia el barrido", err }));
    return { estado: "registrando" };
  }

  async onCitizenRegistered({ transferenciaId, ok, motivo, direccionUnica }) {
    const t = await this.transfers.findById(transferenciaId);
    if (!t || t.tipo !== "entrante" || t.estado !== "registrando") return { ignored: true };
    if (!ok) return this._reject(t, `registro: ${motivo || "fallido"}`);
    const next = await this.transfers.transition(t._id, "registrando", "confirmando", { reqStatus: 1, direccionUnica: direccionUnica || t.direccionUnica, revisarEn: this.now() });
    return next ? this._confirm(next) : { ignored: true };
  }

  /** No se pudo: se deshace lo importado (ms-identidad ya se limpia solo) y se le confirma 0 al origen. */
  async _reject(t, motivo) {
    await this._publish(REVERTIR, { transferenciaId: String(t._id), ciudadanoId: t.ciudadanoId }).catch((err) =>
      logger.error("transferencia.reversion_no_publicada", { transferenciaId: String(t._id), err })
    );
    const next = await this.transfers.transition(t._id, ["importando", "registrando"], "confirmando", { reqStatus: 0, motivo, revisarEn: this.now() });
    await this._audit(t, "transferencia.rechazar", "fallo", motivo);
    return next ? this._confirm(next) : { ignored: true };
  }

  // ---------------------------------------------------------------- 4. confirmar al origen

  async _confirm(t) {
    const final = t.reqStatus === 1 ? "completada" : "rechazada";
    try {
      await this.peer.post(t.confirmApi, { id: t.documento, req_status: t.reqStatus });
    } catch (err) {
      const updated = await this.transfers.update(t._id, "confirmando", { revisarEn: this._later(60000) }, { confirmacionesIntentadas: 1 });
      const intentos = updated ? updated.confirmacionesIntentadas : t.confirmacionesIntentadas + 1;
      logger.warn("transferencia.confirmacion_fallida", { transferenciaId: String(t._id), intento: intentos, err });
      if (!err.definitive && intentos < this.maxConfirmAttempts) return { estado: "confirmando", reintentar: true };
      // Se desiste de avisar: el ciudadano queda (o no) aqui segun el resultado real; el origen resolvera por su plazo.
      await this.transfers.transition(t._id, "confirmando", final, { motivo: `${t.motivo ? `${t.motivo}; ` : ""}origen_no_recibio_confirmacion` });
      return { estado: final, sinConfirmar: true };
    }
    await this.transfers.transition(t._id, "confirmando", final, {}, { confirmacionesIntentadas: 1 });
    await this._audit(t, "transferencia.confirmar_origen", t.reqStatus === 1 ? "exito" : "fallo", t.motivo || undefined);
    logger.info("transferencia.entrante_terminada", { transferenciaId: String(t._id), estado: final });
    return { estado: final };
  }

  // ---------------------------------------------------------------- barrido

  async review(t) {
    const age = this.now().getTime() - new Date(t.iniciadaEn).getTime();
    switch (t.estado) {
      case "importando":
      case "registrando": {
        if (age > 3 * this.stepTimeoutMs) return this._reject(t, `${t.estado}_sin_respuesta`);
        await this.transfers.update(t._id, t.estado, { revisarEn: this._later(this.stepTimeoutMs) });
        const [rk, order] = t.estado === "importando" ? [IMPORTAR, this._importOrder(t)] : [REGISTRAR, this._registerOrder(t)];
        await this._publish(rk, order);
        return { estado: t.estado, reenviada: true };
      }
      case "confirmando":
        return this._confirm(t);
      default:
        return { ignored: true };
    }
  }

  async _audit(t, action, outcome, reason) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({ actor: "ms-interoperabilidad", actorType: "sistema", action, resource: `transferencia:${t._id}`, resourceOwner: t.ciudadanoId, delegated: true, outcome, reason });
    } catch (err) {
      logger.error("audit.write_failed", { action, err });
    }
  }
}

module.exports = { TransferReceiverService, PedidoInvalidoError, CiudadanoYaAfiliadoError, IMPORTAR, REVERTIR, REGISTRAR };
