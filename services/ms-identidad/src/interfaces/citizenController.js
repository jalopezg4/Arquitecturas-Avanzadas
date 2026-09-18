const { ValidationError, ConflictError, ServiceUnavailableError } = require("../application/CitizenSagaService");

function makeCitizenController(citizenSagaService) {
  return {
    async register(req, res) {
      try {
        const result = await citizenSagaService.register(req.body || {});
        return res.status(201).json(result);
      } catch (err) {
        if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
        if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
        if (err instanceof ServiceUnavailableError) return res.status(503).json({ error: err.message });
        // eslint-disable-next-line no-console
        console.error("Error inesperado en registro de ciudadano:", err);
        return res.status(500).json({ error: "Error interno" });
      }
    },
  };
}

module.exports = makeCitizenController;
