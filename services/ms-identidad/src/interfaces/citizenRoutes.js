const express = require("express");

function citizenRoutes(citizenController) {
  const router = express.Router();
  router.post("/citizens", citizenController.register);
  return router;
}

module.exports = citizenRoutes;
