const express = require("express");
const logger = require("../tracing/logger");
const requireAuth = require("../security/requireAuth");
const requireEntityAuth = require("../security/requireEntityAuth");
const { PackageValidationError, PackageNotFoundError, EntidadNoVerificadaError } = require("../application/PackageService");

const BODY_LIMIT = "16kb";

/**
 * Paquetes documentales (HU-06.2).
 *
 * Ciudadano (token de ms-identidad, revalidado aqui; ADR-06):
 *   POST /packages                         {documentoIds, destinatario: {nit?, correo?, nombre?}} -> 202 (se procesa despues)
 *   GET  /citizens/me/packages             paquetes propios (paginado)
 *   GET  /citizens/me/packages/:id         uno propio (ajeno = 404)
 *
 * Entidad (token institucional, ADR-07):
 *   GET  /institutions/me/packages         paquetes ENTREGADOS en su carpeta institucional. Exige que la entidad SIGA
 *                                          verificada (se lee de la base: una revocacion surte efecto de inmediato)
 */
function packageRoutes({ packageService, secrets, issuer, entitySecrets, entityIssuer, auditLogger }) {
  const router = express.Router();
  const citizen = requireAuth(secrets, { issuer });
  const jsonOnly = (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ error: "el cuerpo debe ser application/json" }));

  router.post("/packages", citizen, jsonOnly, express.json({ limit: BODY_LIMIT }), async (req, res, next) => {
    try {
      return res.status(202).json(await packageService.create({ ciudadanoId: req.auth.ciudadanoId, body: req.body }));
    } catch (err) {
      return next(err);
    }
  });

  router.get("/citizens/me/packages", citizen, async (req, res, next) => {
    try {
      return res.status(200).json(await packageService.listMine({ ciudadanoId: req.auth.ciudadanoId, page: req.query.page, pageSize: req.query.pageSize }));
    } catch (err) {
      return next(err);
    }
  });

  router.get("/citizens/me/packages/:id", citizen, async (req, res, next) => {
    try {
      return res.status(200).json(await packageService.getMine({ ciudadanoId: req.auth.ciudadanoId, paqueteId: req.params.id }));
    } catch (err) {
      return next(err);
    }
  });

  if (entitySecrets) {
    router.get("/institutions/me/packages", requireEntityAuth(entitySecrets, entityIssuer ? { issuer: entityIssuer } : undefined), async (req, res, next) => {
      try {
        return res.status(200).json(await packageService.listReceived({ institutionId: req.auth.institutionId, page: req.query.page, pageSize: req.query.pageSize }));
      } catch (err) {
        if (err instanceof EntidadNoVerificadaError && auditLogger) {
          await auditLogger
            .record({ actor: req.auth.institutionId, actorType: "entidad", action: "paquete.listar", resource: "carpeta_institucional", resourceOwner: req.auth.institutionId, outcome: "rechazo", reason: "entidad_no_verificada" })
            .catch((e) => logger.error("audit.write_failed", { err: e }));
        }
        return next(err);
      }
    });
  }
  return router;
}

/** Solo atiende los errores de paquetes; el resto sigue al manejador general. */
function packageErrorHandler(err, _req, res, next) {
  if (err instanceof PackageValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof PackageNotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof EntidadNoVerificadaError) return res.status(403).json({ error: err.message });
  return next(err);
}

module.exports = { packageRoutes, packageErrorHandler };
