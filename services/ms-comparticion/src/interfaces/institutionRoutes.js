const crypto = require("crypto");
const express = require("express");
const logger = require("../tracing/logger");
const { ValidationError, ConflictError } = require("../application/InstitutionService");

const BODY_LIMIT = "16kb"; // un registro son unos cientos de bytes: un cuerpo grande es un abuso

/** Compara en tiempo constante (con hash de por medio para no depender de la longitud). */
function sameToken(given, expected) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * POST /institutions -- registro de una entidad institucional (HU-06.1).
 * Orden: 1) token de registro, si esta configurado (ANTES de leer el cuerpo) -> 2) debe ser JSON -> 3) cuerpo acotado
 * -> 4) servicio.
 */
function institutionRoutes({ institutionService, registrationToken }) {
  const router = express.Router();

  const guard = (req, res, next) => {
    if (!registrationToken || sameToken(req.get("x-registration-token"), registrationToken)) return next();
    logger.warn("institucion.token_invalido");
    return res.status(401).json({ error: "token de registro invalido o ausente" });
  };
  const jsonOnly = (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ error: "el cuerpo debe ser application/json" }));

  router.post("/institutions", guard, jsonOnly, express.json({ limit: BODY_LIMIT }), async (req, res, next) => {
    try {
      const result = await institutionService.register(req.body);
      return res.status(201).json(result);
    } catch (err) {
      return next(err);
    }
  });
  return router;
}

/** Traduce errores conocidos a respuestas HTTP; lo inesperado es un 500 generico (sin detalles internos). */
function errorHandler(err, _req, res, _next) {
  if (err instanceof ValidationError) return res.status(400).json({ error: "datos invalidos", detalles: err.problems });
  if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "el cuerpo es demasiado grande" });
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) return res.status(400).json({ error: "el cuerpo no es un JSON valido" });
  logger.error("instituciones.error_inesperado", { err });
  return res.status(500).json({ error: "Error interno" });
}

module.exports = { institutionRoutes, errorHandler };
