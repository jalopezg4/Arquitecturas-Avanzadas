const express = require("express");
const logger = require("../tracing/logger");
const requireAuth = require("../security/requireAuth");
const { CiudadanoNoDisponibleError, ConfirmacionInvalidaError } = require("../application/TransferSagaService");
const { TransferConflictError } = require("../infrastructure/TransferRepository");
const { OperatorNotFoundError, NoTransferEndpointError, SelfTransferError, DirectoryUnavailableError, ValidationError } = require("../application/OperatorDirectoryService");
const { UnsafeTransferUrlError } = require("../security/transferUrl");
const { PedidoInvalidoError, CiudadanoYaAfiliadoError } = require("../application/TransferReceiverService");

const OPERATOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

function jsonOnly(req, res, next) {
  if (!req.is("application/json")) return res.status(415).json({ error: "se espera application/json" });
  return next();
}

/** `id` del protocolo: la cedula como numero (se acepta tambien como texto de digitos). */
function parseCedula(value) {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Rutas de la transferencia (HU-05c).
 *
 * Ciudadano (token de ms-identidad, revalidado aqui; ADR-06):
 *   POST /api/v1/transfers                  {operadorDestinoId}  -> 202 {transferenciaId, estado, operadorDestino}
 *   GET  /api/v1/citizens/me/transfer                            -> 200 transferencia en curso | 404
 *
 * Entre operadores (publicas: el protocolo del curso no define autenticacion entre operadores):
 *   POST /api/transferCitizen  {id, citizenName, citizenEmail, urlDocuments, confirmAPI, ...opcionales}
 *        -> 202: se acepta y se procesa despues; el resultado se le avisa al origen en su confirmAPI.
 *   POST /api/transferCitizenConfirm?t=<token>  {id, req_status}  -> 200. El token viaja en NUESTRO confirmAPI:
 *        sin el, una confirmacion no se acepta (cualquiera que conozca una cedula podria hacernos borrar al ciudadano).
 */
function transferRoutes({ sagaService, receiverService, secrets, issuer }) {
  const router = express.Router();
  const json = express.json({ limit: "16kb" });
  // Un pedido de transferencia trae una URL por documento (hasta TRANSFER_MAX_DOCUMENTS): mas margen, pero acotado.
  const transferJson = express.json({ limit: "1mb" });

  if (receiverService) {
    router.post("/transferCitizen", jsonOnly, transferJson, async (req, res, next) => {
      try {
        const result = await receiverService.receive(req.body);
        return res.status(202).json({ mensaje: "transferencia recibida; se confirmara en confirmAPI", transferenciaId: result.transferenciaId });
      } catch (err) {
        return next(err);
      }
    });
  }

  router.post("/v1/transfers", requireAuth(secrets, { issuer }), jsonOnly, json, async (req, res, next) => {
    try {
      const { operadorDestinoId } = req.body || {};
      if (typeof operadorDestinoId !== "string" || !OPERATOR_ID_RE.test(operadorDestinoId)) return res.status(400).json({ error: "operadorDestinoId invalido" });
      const result = await sagaService.initiate({ ciudadanoId: req.auth.ciudadanoId, operadorDestinoId });
      return res.status(202).json(result);
    } catch (err) {
      return next(err);
    }
  });

  router.get("/v1/citizens/me/transfer", requireAuth(secrets, { issuer }), async (req, res, next) => {
    try {
      const current = await sagaService.current(req.auth.ciudadanoId);
      return current ? res.status(200).json(current) : res.status(404).json({ error: "no hay una transferencia en curso" });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/transferCitizenConfirm", jsonOnly, json, async (req, res, next) => {
    try {
      const token = typeof req.query.t === "string" ? req.query.t : "";
      const body = req.body || {};
      const id = parseCedula(body.id);
      const reqStatus = body.req_status === 1 || body.req_status === "1" ? 1 : body.req_status === 0 || body.req_status === "0" ? 0 : null;
      if (!TOKEN_RE.test(token) || id === null || reqStatus === null) return res.status(400).json({ error: "confirmacion invalida: se espera {id, req_status: 1|0}" });
      const result = await sagaService.confirm({ id, reqStatus, token });
      return res.status(200).json({ id, estado: result.estado });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/** Errores conocidos -> HTTP; lo inesperado es un 500 generico sin detalles internos. */
function transferErrorHandler(err, _req, res, _next) {
  if (err instanceof CiudadanoNoDisponibleError || err instanceof TransferConflictError) return res.status(409).json({ error: err.message });
  if (err instanceof SelfTransferError) return res.status(400).json({ error: "no puedes transferirte al operador en el que ya estas" });
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof OperatorNotFoundError) return res.status(404).json({ error: "operador destino no encontrado" });
  if (err instanceof NoTransferEndpointError || err instanceof UnsafeTransferUrlError) return res.status(409).json({ error: "el operador destino no tiene una direccion de transferencia valida publicada" });
  if (err instanceof DirectoryUnavailableError) return res.status(503).json({ error: "el directorio de operadores no esta disponible" });
  if (err instanceof ConfirmacionInvalidaError) return res.status(404).json({ error: err.message });
  if (err instanceof PedidoInvalidoError) return res.status(400).json({ error: err.message });
  if (err instanceof CiudadanoYaAfiliadoError) return res.status(409).json({ error: err.message });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "el cuerpo es demasiado grande" });
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) return res.status(400).json({ error: "el cuerpo no es un JSON valido" });
  logger.error("interoperabilidad.error_inesperado", { err });
  return res.status(500).json({ error: "Error interno" });
}

module.exports = { transferRoutes, transferErrorHandler, parseCedula };
