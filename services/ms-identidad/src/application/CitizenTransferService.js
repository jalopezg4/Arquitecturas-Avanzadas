const crypto = require("crypto");
const logger = require("../tracing/logger");
const { publishCitizenRegistered } = require("./events");

const IMPORTADO = "transferencia.ciudadano_registrado";
const DIRECCION_UNICA_RE = /^[^\s@<>,;]+@carpetacolombia\.co$/i;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin confirmacion del broker tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * HU-05c en ms-identidad (el dueno del ciudadano):
 *
 *   onTransferred    (origen)  el destino confirmo: se revocan las sesiones y se borra al ciudadano (RF-08)
 *   importCitizen    (destino) llega un ciudadano de otro operador: se crea CONSERVANDO su direccion unica (RF-10),
 *                              se afilia a NOSOTROS en GovCarpeta y se publica `ciudadano.registrado` (carpeta en
 *                              ms-documentos, bienvenida en ms-notificaciones). Responde a ms-interoperabilidad con
 *                              `transferencia.ciudadano_registrado` {ok, motivo}.
 *
 * Mismo cuidado que la saga de HU-01: se persiste `pendiente` ANTES de GovCarpeta, `registerCitizen` no se reintenta a
 * ciegas y un resultado ambiguo se resuelve preguntando a GovCarpeta (validateCitizen).
 */
class CitizenTransferService {
  constructor({ citizenRepository, refreshSessionRepository, govCarpetaClient, eventPublisher, auditLogger, accountActivationService, eventPublishTimeoutMs = 3000, now = () => new Date() }) {
    // Opcional: sin el, el ciudadano importado queda sin forma de fijar su contrasena.
    this.activation = accountActivationService;
    this.citizens = citizenRepository;
    this.sessions = refreshSessionRepository;
    this.govCarpeta = govCarpetaClient;
    this.eventPublisher = eventPublisher;
    this.auditLogger = auditLogger;
    this.eventPublishTimeoutMs = eventPublishTimeoutMs;
    this.now = now;
  }

  // ------------------------------------------------------------------ origen

  async onTransferred({ transferenciaId, ciudadanoId }) {
    const revoked = await this.sessions.revokeAllFor(ciudadanoId, this.now());
    const { deletedCount } = await this.citizens.deleteTransferred(ciudadanoId);
    if (deletedCount) {
      logger.info("ciudadano.transferido", { transferenciaId, sesionesRevocadas: revoked });
      await this._audit({ actor: "ms-interoperabilidad", action: "ciudadano.transferir", ciudadanoId, outcome: "exito", metadata: { transferenciaId } });
    }
    return { deleted: deletedCount > 0 };
  }

  // ------------------------------------------------------------------ destino

  async importCitizen(req) {
    const result = await this._import(req);
    await this._audit({ actor: "ms-interoperabilidad", action: "ciudadano.importar", ciudadanoId: req.ciudadanoId, outcome: result.ok ? "exito" : "fallo", reason: result.motivo, metadata: { transferenciaId: req.transferenciaId } });
    // Si el broker no confirma la respuesta se lanza: el consumidor reintenta y este metodo responde lo mismo (idempotente).
    await withTimeout(this.eventPublisher.publish(IMPORTADO, { transferenciaId: req.transferenciaId, ciudadanoId: req.ciudadanoId, ...result }), this.eventPublishTimeoutMs);
    return result;
  }

  async _import({ ciudadanoId, documento, nombre, correo, direccion, direccionUnica }) {
    let citizen = await this.citizens.findByDocumento(documento);
    if (citizen && String(citizen._id) !== ciudadanoId) return { ok: false, motivo: "ya_registrado_en_este_operador" };

    if (!citizen) {
      let dir = typeof direccionUnica === "string" && DIRECCION_UNICA_RE.test(direccionUnica.trim()) ? direccionUnica.trim().toLowerCase() : null;
      if (!dir) {
        // RF-10: la direccion unica NO debe cambiar, pero el protocolo minimo no la transporta. Si el origen no la envio,
        // no hay forma de conservarla: se genera una y queda constancia.
        dir = `${documento}-${crypto.randomBytes(4).toString("hex")}@carpetacolombia.co`;
        logger.warn("ciudadano.importado_sin_direccion_unica", { note: "el operador origen no envio direccionUnica (RF-10)" });
      }
      try {
        citizen = await this.citizens.create({ _id: ciudadanoId, documento, nombre, correo, direccion: direccion || "No informada", passwordHash: null, direccionUnica: dir, estado: "pendiente" });
      } catch (err) {
        if (err && err.code === 11000) {
          if (err.keyPattern && err.keyPattern.direccionUnica) return { ok: false, motivo: "direccion_unica_en_uso" };
          return this._import({ ciudadanoId, documento, nombre, correo, direccion, direccionUnica }); // carrera con otra entrega
        }
        throw err;
      }
    } else if (citizen.estado === "activo") {
      await this._publishRegistered(citizen); // reentrega: ya estaba; se asegura el evento
      return { ok: true, direccionUnica: citizen.direccionUnica };
    } else {
      // Pendiente de una entrega anterior que no termino: quiza GovCarpeta SI lo registro. Se pregunta antes de reintentar.
      const affiliated = await this._isAffiliated(documento);
      if (affiliated === true) return this._activate(citizen);
      if (affiliated === null) throw new Error("GovCarpeta no responde; se reintentara la importacion");
    }

    try {
      await this.govCarpeta.registerCitizen({ id: documento, name: nombre, address: citizen.direccion, email: correo });
    } catch (err) {
      const status = err && err.response ? err.response.status : undefined;
      const ambiguous = status === undefined || (status >= 500 && status !== 501);
      if (!ambiguous) {
        await this.citizens.deletePending(citizen._id);
        return { ok: false, motivo: `govcarpeta_rechazo_${status}` };
      }
      const affiliated = await this._isAffiliated(documento);
      if (affiliated !== true) {
        await this.citizens.deletePending(citizen._id);
        return { ok: false, motivo: "govcarpeta_no_disponible" };
      }
      // Afiliado: se asume que fue nuestra llamada (mismo supuesto que PendingRegistrationReconciler, ver SEGURIDAD.md).
    }
    return this._activate(citizen);
  }

  async _activate(citizen) {
    const active = await this.citizens.activatePending(citizen._id);
    const current = active || (await this.citizens.findById(citizen._id));
    await this._publishRegistered(current);
    // Recien activado y sin contrasena (la contrasena no viaja entre operadores): se le envia el codigo de activacion.
    if (active && this.activation && !current.passwordHash) await this.activation.issue(current._id).catch(() => false);
    return { ok: true, direccionUnica: current.direccionUnica };
  }

  async _publishRegistered(citizen) {
    if (citizen.eventoPublicado) return;
    const ok = await publishCitizenRegistered(this.eventPublisher, citizen, { timeoutMs: this.eventPublishTimeoutMs });
    if (ok) await this.citizens.markEventPublished(citizen._id); // si no, lo reenvia PendingRegistrationReconciler
  }

  /** true = afiliado; false = disponible; null = GovCarpeta no respondio. */
  async _isAffiliated(documento) {
    try {
      const { available } = await this.govCarpeta.validateCitizen(documento);
      return !available;
    } catch {
      return null;
    }
  }

  async _audit({ actor, action, ciudadanoId, outcome, reason, metadata }) {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.record({ actor, actorType: "sistema", action, resource: `ciudadano:${ciudadanoId}`, resourceOwner: ciudadanoId, delegated: true, outcome, reason, metadata });
    } catch (err) {
      logger.error("audit.write_failed", { action, err });
    }
  }
}

module.exports = { CitizenTransferService, IMPORTADO };
