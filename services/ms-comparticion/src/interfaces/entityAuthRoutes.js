const express = require("express");
const logger = require("../tracing/logger");
const { InvalidCredentialsError } = require("../application/EntityAuthService");

const BODY_LIMIT = "4kb"; // unas credenciales son unos cientos de bytes: un cuerpo grande es un abuso

/**
 * POST /institutions/auth/token -- autenticacion de una ENTIDAD institucional (ADR-07).
 *
 * Es el equivalente institucional de POST /auth/login (HU-02, ms-identidad) y es PUBLICA por la misma razon
 * que aquella: no se puede exigir un token para pedir un token. Lo que protege no es un encabezado, es la
 * credencial misma (NIT + contrasena, Argon2id).
 *
 * Orden: 1) debe ser JSON -> 2) cuerpo acotado -> 3) servicio.
 */
function entityAuthRoutes({ entityAuthService }) {
  const router = express.Router();

  const jsonOnly = (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ error: "el cuerpo debe ser application/json" }));

  router.post("/institutions/auth/token", jsonOnly, express.json({ limit: BODY_LIMIT }), async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const result = await entityAuthService.authenticate({ nit: body.nit, password: body.password });
      res.set("Cache-Control", "no-store"); // la respuesta contiene una credencial: que no se guarde en caches
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/**
 * Traduce SOLO el error de credenciales (401 siempre igual, sin distinguir NIT inexistente, contrasena incorrecta
 * o entidad bloqueada). Todo lo demas -- cuerpo demasiado grande, JSON mal formado, fallo inesperado -- sigue hacia
 * el `errorHandler` del servicio, que ya lo traduce igual para todas las rutas. Se registra ANTES que aquel.
 */
function entityAuthErrorHandler(err, _req, res, next) {
  if (!(err instanceof InvalidCredentialsError)) return next(err);
  logger.warn("entidad.autenticacion_rechazada"); // sin NIT ni motivo: el detalle esta en la bitacora
  res.set("WWW-Authenticate", 'Bearer realm="carpeta-ciudadana-entidades"');
  return res.status(401).json({ error: err.message });
}

module.exports = { entityAuthRoutes, entityAuthErrorHandler };
