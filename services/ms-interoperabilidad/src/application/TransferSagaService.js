const crypto = require("crypto");
const logger = require("../tracing/logger");
const { CONFIRM_PATH } = require("./EndpointRegistrationService");

class CiudadanoNoDisponibleError extends Error {
  constructor() {
    super("tus datos aun no estan disponibles para transferir; intenta de nuevo en unos minutos");
    this.name = "CiudadanoNoDisponibleError";
  }
}
class ConfirmacionInvalidaError extends Error {
  constructor() {
    super("no hay una transferencia pendiente de confirmacion con esos datos");
    this.name = "ConfirmacionInvalidaError";
  }
}

const EXPORTAR = "transferencia.exportar_carpeta";
const CANCELADA = "transferencia.cancelada";
const TRANSFERIDO = "ciudadano.transferido";

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * HU-05c, lado ORIGEN: saga de transferencia de un ciudadano de ESTE operador a otro (protocolo acordado entre los
 * equipos del curso; ver PROTOCOLO_TRANSFERENCIA.md y docs/SEGURIDAD.md, seccion 14).
 *
 *   1. initiate()        el ciudadano pide irse -> se registra la transferencia y se ordena exportar la carpeta
 *   2. onFolderExported  ms-documentos bloqueo la carpeta y entrego las URLs -> se envia
 *   3. _send()           unregisterCitizen en GovCarpeta (una vez) + POST transferCitizen al destino
 *   4. confirm()         el destino confirma: 1 -> ciudadano.transferido (se borran sus datos); 0 -> compensar
 *   5. sweep()           plazos: reenvia sin confirmacion (5 min), y agotados los envios compensa
 *   compensar            re-afiliar en GovCarpeta (si ya se habia desafiliado) + desbloquear la carpeta
 *
 * Cada paso es una transicion condicional sobre el estado guardado: una confirmacion que llega mientras el barrido
 * reenvia, o dos replicas del servicio, nunca aplican el mismo paso dos veces.
 */
class TransferSagaService {
  constructor({ transferRepository, citizenRepository, directory, govCarpetaClient, peerClient, eventPublisher, auditLogger, publicBaseUrl, confirmTimeoutMs = 5 * 60 * 1000, maxSendAttempts = 3, stepTimeoutMs = 2 * 60 * 1000, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    this.transfers = transferRepository;
    this.citizens = citizenRepository;
    this.directory = directory;
    this.govCarpeta = govCarpetaClient;
    this.peer = peerClient;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.confirmBase = `${String(publicBaseUrl || "").replace(/\/+$/, "")}${CONFIRM_PATH}`;
    this.confirmTimeoutMs = confirmTimeoutMs;
    this.maxSendAttempts = maxSendAttempts;
    this.stepTimeoutMs = stepTimeoutMs;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  _later(ms) {
    return new Date(this.now().getTime() + ms);
  }

  async _publish(routingKey, payload) {
    await withTimeout(this.eventPublisher.publish(routingKey, payload), this.eventPublishTimeoutMs);
  }

  // ---------------------------------------------------------------- 1. el ciudadano pide la transferencia

  async initiate({ ciudadanoId, operadorDestinoId }) {
    const citizen = await this.citizens.find(ciudadanoId);
    if (!citizen) throw new CiudadanoNoDisponibleError();
    // Estricto (nunca una copia vieja), valida la URL publicada y rechaza transferirse a este mismo operador.
    const destino = await this.directory.resolveTransferAddress(operadorDestinoId);

    const transfer = await this.transfers.create({
      tipo: "saliente",
      estado: "exportando",
      ciudadanoId,
      documento: citizen.documento,
      nombre: citizen.nombre,
      correo: citizen.correo,
      direccionUnica: citizen.direccionUnica || null,
      direccion: citizen.direccion || null,
      operadorDestinoId: destino.operatorId,
      operadorDestinoNombre: destino.name,
      destinoUrl: destino.transferApiUrl,
      revisarEn: this._later(this.stepTimeoutMs),
    });
    await this._audit(transfer, "transferencia.iniciar", "exito");
    // Si el broker no confirma, el barrido reenvia la orden al vencer `revisarEn`: la solicitud no falla.
    await this._publish(EXPORTAR, { transferenciaId: String(transfer._id), ciudadanoId }).catch((err) =>
      logger.error("transferencia.orden_no_publicada", { transferenciaId: String(transfer._id), note: "la reenvia el barrido", err })
    );
    return { transferenciaId: String(transfer._id), estado: transfer.estado, operadorDestino: destino.name };
  }

  async current(ciudadanoId) {
    const t = await this.transfers.findActive("saliente", { ciudadanoId });
    return t ? { transferenciaId: String(t._id), estado: t.estado, operadorDestino: t.operadorDestinoNombre, iniciadaEn: t.createdAt } : null;
  }

  // ---------------------------------------------------------------- 2. carpeta exportada

  async onFolderExported({ transferenciaId, ok, motivo, documentos }) {
    const transfer = await this.transfers.findById(transferenciaId);
    if (!transfer || transfer.tipo !== "saliente" || transfer.estado !== "exportando") return { ignored: true };
    if (!ok) return this._fail(transfer, motivo || "exportacion_fallida");

    const items = (documentos || []).map((d, i) => ({
      clave: `URL${i + 1}`,
      url: d.url,
      titulo: d.titulo || null,
      entidadAvaladora: d.entidadAvaladora || null,
      fecha: d.fecha || null,
      estado: d.estado || null,
      sha256: d.sha256 || null,
    }));
    const ready = await this.transfers.transition(transfer._id, "exportando", "enviando", {
      documentos: items,
      confirmToken: crypto.randomBytes(24).toString("base64url"),
      revisarEn: this.now(),
    });
    if (!ready) return { ignored: true };
    return this._send(ready);
  }

  // ---------------------------------------------------------------- 3. enviar al destino

  /** Cuerpo del protocolo acordado + campos OPCIONALES (metadatos, direccion unica) que un receptor puede ignorar. */
  _body(t) {
    const urlDocuments = {};
    const metadata = {};
    for (const d of t.documentos) {
      urlDocuments[d.clave] = [d.url];
      metadata[d.clave] = { titulo: d.titulo, entidadAvaladora: d.entidadAvaladora, fecha: d.fecha, estado: d.estado, sha256: d.sha256 };
    }
    return {
      id: t.documento,
      citizenName: t.nombre,
      citizenEmail: t.correo,
      urlDocuments,
      confirmAPI: `${this.confirmBase}?t=${encodeURIComponent(t.confirmToken)}`,
      // Extensiones opcionales (decision del equipo, PROTOCOLO_TRANSFERENCIA.md): RF-10 y metadatos del documento.
      ...(t.direccionUnica ? { direccionUnica: t.direccionUnica } : {}),
      ...(t.direccion ? { citizenAddress: t.direccion } : {}),
      metadata,
    };
  }

  async _send(t) {
    // (a) Desafiliar en GovCarpeta, una sola vez: el destino no podria registrarlo mientras siga afiliado a nosotros.
    if (!t.desafiliadoEnGovCarpeta) {
      try {
        await this.govCarpeta.unregisterCitizen(t.documento);
      } catch (err) {
        return this._sendFailed(t, err, "govcarpeta_no_desafilio");
      }
      t = (await this.transfers.update(t._id, "enviando", { desafiliadoEnGovCarpeta: true })) || t;
    }
    // (b) POST transferCitizen al destino.
    try {
      await this.peer.post(t.destinoUrl, this._body(t));
    } catch (err) {
      return this._sendFailed(t, err, "destino_no_recibio");
    }
    const waiting = await this.transfers.transition(t._id, "enviando", "esperando_confirmacion", { revisarEn: this._later(this.confirmTimeoutMs) }, { enviosRealizados: 1 });
    logger.info("transferencia.enviada", { transferenciaId: String(t._id), envio: waiting ? waiting.enviosRealizados : null });
    return { estado: "esperando_confirmacion" };
  }

  async _sendFailed(t, err, motivo) {
    const updated = await this.transfers.update(t._id, "enviando", { revisarEn: this._later(Math.min(this.confirmTimeoutMs, 60000)) }, { enviosRealizados: 1 });
    const envios = updated ? updated.enviosRealizados : t.enviosRealizados + 1;
    logger.warn("transferencia.envio_fallido", { transferenciaId: String(t._id), envio: envios, motivo, err });
    if (err && err.definitive) return this._fail(updated || t, motivo);
    if (envios >= this.maxSendAttempts) return this._fail(updated || t, `${motivo}_reintentos_agotados`);
    return { estado: "enviando", reintentar: true };
  }

  // ---------------------------------------------------------------- 4. confirmacion del destino

  /**
   * `POST /api/transferCitizenConfirm?t=<token>` desde el destino. `req_status` 1 = ya tiene todo (se borran los datos
   * del ciudadano aqui, RF-08); 0 = no pudo (se compensa). Idempotente: una confirmacion repetida de una transferencia
   * ya completada responde igual sin volver a borrar nada.
   */
  async confirm({ id, reqStatus, token }) {
    const active = await this.transfers.findActive("saliente", { documento: id });
    if (!active) {
      const last = await this.transfers.findLatestByDocumento("saliente", id);
      if (last && sameToken(token, last.confirmToken) && ["completada", "fallida"].includes(last.estado)) return { estado: last.estado, repetida: true };
      throw new ConfirmacionInvalidaError();
    }
    if (!sameToken(token, active.confirmToken) || !["enviando", "esperando_confirmacion"].includes(active.estado)) throw new ConfirmacionInvalidaError();

    if (reqStatus !== 1) {
      await this._audit(active, "transferencia.confirmar", "rechazo", "destino_reporto_fallo");
      await this._fail(active, "destino_reporto_fallo");
      return { estado: "fallida" };
    }

    // Primero el evento (ms-documentos borra la carpeta, ms-identidad marca transferido): si el broker no lo confirma,
    // se responde error y el destino reintenta la confirmacion; el estado no avanzo.
    await this._publish(TRANSFERIDO, { transferenciaId: String(active._id), ciudadanoId: active.ciudadanoId, operadorDestinoId: active.operadorDestinoId });
    const done = await this.transfers.transition(active._id, ["enviando", "esperando_confirmacion"], "completada", { motivo: null });
    await this.citizens.remove(active.ciudadanoId);
    await this._audit(active, "transferencia.confirmar", "exito");
    logger.info("transferencia.completada", { transferenciaId: String(active._id) });
    return { estado: done ? done.estado : "completada" };
  }

  // ---------------------------------------------------------------- compensacion

  /**
   * Deshace lo hecho: re-afilia en GovCarpeta si ya se habia desafiliado (una sola vez) y desbloquea la carpeta. Si
   * algo falla a mitad queda `fallando` y el barrido lo retoma.
   */
  async _fail(t, motivo) {
    const marked = await this.transfers.update(t._id, t.estado, { fallando: true, motivo: t.motivo || motivo, revisarEn: this._later(60000) });
    const cur = marked || t;
    if (cur.desafiliadoEnGovCarpeta && !cur.reafiliado) {
      try {
        await this.govCarpeta.registerCitizen({ id: cur.documento, name: cur.nombre, address: cur.direccion || "No informada", email: cur.correo });
        await this.transfers.update(cur._id, cur.estado, { reafiliado: true });
      } catch (err) {
        if (!err.definitive) {
          logger.error("transferencia.compensacion_pendiente", { transferenciaId: String(cur._id), note: "GovCarpeta no respondio; la reintenta el barrido", err });
          return { estado: cur.estado, compensando: true };
        }
        // 501 = ya esta afiliado (quiza el destino alcanzo a registrarlo): no se puede re-afiliar automaticamente.
        logger.error("transferencia.compensacion_incompleta", { transferenciaId: String(cur._id), note: "requiere revision manual en GovCarpeta", err });
        await this.transfers.update(cur._id, cur.estado, { motivo: `${cur.motivo || motivo}; reafiliacion_fallida_${err.response ? err.response.status : "?"}` });
      }
    }
    try {
      await this._publish(CANCELADA, { transferenciaId: String(cur._id), ciudadanoId: cur.ciudadanoId });
    } catch (err) {
      logger.error("transferencia.compensacion_pendiente", { transferenciaId: String(cur._id), note: "no se pudo desbloquear la carpeta; lo reintenta el barrido", err });
      return { estado: cur.estado, compensando: true };
    }
    const failed = await this.transfers.transition(cur._id, ["exportando", "enviando", "esperando_confirmacion"], "fallida", { fallando: false });
    await this._audit(cur, "transferencia.fallar", "fallo", (failed && failed.motivo) || motivo);
    logger.warn("transferencia.fallida", { transferenciaId: String(cur._id), motivo: (failed && failed.motivo) || motivo });
    return { estado: "fallida" };
  }

  // ---------------------------------------------------------------- 5. barrido de plazos

  /** Revisa una transferencia SALIENTE vencida. Devuelve lo que hizo (para logs y pruebas). */
  async review(t) {
    if (t.fallando) return this._fail(t, t.motivo || "compensacion");
    const age = this.now().getTime() - new Date(t.createdAt).getTime();
    switch (t.estado) {
      case "exportando":
        // Sin respuesta de ms-documentos: se repite la orden (idempotente); tras 3 plazos se desiste.
        if (age > 3 * this.stepTimeoutMs) return this._fail(t, "exportacion_sin_respuesta");
        await this.transfers.update(t._id, "exportando", { revisarEn: this._later(this.stepTimeoutMs) });
        await this._publish(EXPORTAR, { transferenciaId: String(t._id), ciudadanoId: t.ciudadanoId });
        return { estado: "exportando", reenviada: true };
      case "enviando":
        return this._send(t);
      case "esperando_confirmacion": {
        // 5 minutos sin confirmacion: se reenvia (el destino debe ser idempotente) hasta agotar los envios.
        if (t.enviosRealizados >= this.maxSendAttempts) return this._fail(t, "sin_confirmacion_del_destino");
        const back = await this.transfers.transition(t._id, "esperando_confirmacion", "enviando", { revisarEn: this.now() });
        return back ? this._send(back) : { ignored: true };
      }
      default:
        return { ignored: true };
    }
  }

  async _audit(t, action, outcome, reason) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({
        actor: action === "transferencia.iniciar" ? t.ciudadanoId : "ms-interoperabilidad",
        actorType: action === "transferencia.iniciar" ? "ciudadano" : "sistema",
        action,
        resource: `transferencia:${t._id}`,
        resourceOwner: t.ciudadanoId,
        delegated: action !== "transferencia.iniciar",
        outcome,
        reason,
        metadata: { operadorDestinoId: t.operadorDestinoId },
      });
    } catch (err) {
      logger.error("audit.write_failed", { action, err });
    }
  }
}

module.exports = { TransferSagaService, CiudadanoNoDisponibleError, ConfirmacionInvalidaError, EXPORTAR, CANCELADA, TRANSFERIDO };
