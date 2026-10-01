const express = require("express");
const { TRANSFER_PATH, CONFIRM_PATH, validateTransferCitizen, validateConfirm } = require("./protocol");

/**
 * HT-05: operador de REFERENCIA en memoria que implementa el protocolo acordado tal como esta escrito. Sirve para
 * correr la suite de contrato en CI sin depender de otro equipo, y como ejemplo ejecutable del contrato.
 *
 * Al recibir un transferCitizen valido responde 202, descarga cada URL (comprueba que respondan) y luego llama al
 * confirmAPI con {id, req_status: 1} (0 si alguna descarga fallo). `behavior` permite simular operadores que NO cumplen,
 * para probar que la suite los detecta.
 */
function createReferenceOperator({ behavior = {}, fetchImpl = fetch } = {}) {
  const received = { transfers: [], confirms: [] };
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post(TRANSFER_PATH, (req, res) => {
    if (behavior.transferStatus) return res.status(behavior.transferStatus).json({ error: "simulado" });
    const problems = validateTransferCitizen(req.body);
    if (problems.length) return res.status(400).json({ error: "pedido invalido", problems });
    received.transfers.push(req.body);
    res.status(202).json({ mensaje: "recibido" });

    // Asincrono, como en un operador real: primero trae los documentos, despues confirma.
    setImmediate(async () => {
      if (behavior.neverConfirm) return;
      let ok = 1;
      for (const urls of Object.values(req.body.urlDocuments)) {
        for (const url of urls) {
          try {
            const r = await fetchImpl(url);
            if (!r.ok) ok = 0;
          } catch {
            ok = 0;
          }
        }
      }
      const body = behavior.confirmBody ? behavior.confirmBody(req.body) : { id: req.body.id, req_status: ok };
      try {
        await fetchImpl(req.body.confirmAPI, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch {
        // el origen no responde: en un operador real se reintentaria
      }
    });
    return undefined;
  });

  app.post(CONFIRM_PATH, (req, res) => {
    const problems = validateConfirm(req.body);
    if (problems.length) return res.status(400).json({ error: "confirmacion invalida", problems });
    received.confirms.push(req.body);
    return res.status(200).json({ id: req.body.id });
  });

  return { app, received };
}

module.exports = { createReferenceOperator };
