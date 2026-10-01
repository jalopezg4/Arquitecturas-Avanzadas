const logger = require("../tracing/logger");
const { ValidationError } = require("../application/CitizenSagaService");
const { InvalidCredentialsError, InvalidTokenError } = require("../application/AuthService");
const { ActivacionInvalidaError, ActivacionDatosError } = require("../application/AccountActivationService");

function makeAuthController(authService, activationService) {
  return {
    /** Activacion de cuenta del ciudadano transferido: fija su contrasena con el codigo que recibio por correo. */
    async activate(req, res) {
      try {
        if (!activationService) return res.status(404).json({ error: "no disponible" });
        const result = await activationService.activate(req.body || {});
        res.set("Cache-Control", "no-store");
        return res.status(200).json(result);
      } catch (err) {
        if (err instanceof ActivacionInvalidaError) return res.status(401).json({ error: err.message });
        if (err instanceof ActivacionDatosError) return res.status(400).json({ error: err.message });
        logger.error("activacion.error_inesperado", { err });
        return res.status(500).json({ error: "Error interno" });
      }
    },

    async resendActivation(req, res) {
      try {
        if (!activationService) return res.status(404).json({ error: "no disponible" });
        return res.status(202).json(await activationService.resend(req.body || {}));
      } catch (err) {
        if (err instanceof ActivacionDatosError) return res.status(400).json({ error: err.message });
        logger.error("activacion.error_inesperado", { err });
        return res.status(500).json({ error: "Error interno" });
      }
    },

    async login(req, res) {
      try {
        const tokens = await authService.login(req.body || {});
        res.set("Cache-Control", "no-store"); // la respuesta contiene credenciales: que no se guarde en caches
        return res.status(200).json(tokens);
      } catch (err) {
        if (err instanceof InvalidCredentialsError) return res.status(401).json({ error: err.message });
        if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
        logger.error("login.error_inesperado", { err });
        return res.status(500).json({ error: "Error interno" });
      }
    },

    async refresh(req, res) {
      try {
        const tokens = await authService.refresh(req.body || {});
        res.set("Cache-Control", "no-store");
        return res.status(200).json(tokens);
      } catch (err) {
        if (err instanceof InvalidTokenError) return res.status(401).json({ error: err.message });
        if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
        logger.error("refresh.error_inesperado", { err });
        return res.status(500).json({ error: "Error interno" });
      }
    },

    /** Devuelve la identidad del token ya validado: sirve para comprobar la sesion de extremo a extremo. */
    me(req, res) {
      return res.status(200).json({ ciudadanoId: req.auth.ciudadanoId });
    },
  };
}

module.exports = makeAuthController;
