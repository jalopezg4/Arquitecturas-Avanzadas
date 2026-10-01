const crypto = require("crypto");
const express = require("express");
const { TRANSFER_PATH, CONFIRM_PATH, validateConfirm } = require("./protocol");

// PDF minimo valido: es lo que el operador bajo prueba descargara de las URLs que le enviamos.
const SAMPLE_PDF = Buffer.from("%PDF-1.4\n% documento de prueba de contrato HT-05\n%%EOF\n");

/**
 * HT-05 (RNF-11): suite de CONTRATO del protocolo de transferencia acordado entre los equipos del curso, ejecutable
 * contra la URL base de CUALQUIER operador (el nuestro, el de referencia o el de otro equipo).
 *
 * Hace de operador ORIGEN: levanta un servidor propio que sirve documentos de prueba y recibe la confirmacion, envia un
 * transferCitizen valido y verifica que el operador bajo prueba confirme segun lo acordado. Cada caso es
 * `obligatorio` (define si el operador cumple, RNF-11: 100% de los casos validos) o `recomendado` (buenas practicas que
 * el protocolo no exige: se reportan sin hacer fallar la suite).
 *
 * `callbackBaseUrl`: direccion con la que el operador bajo prueba alcanza a ESTE servidor (en local, la del puerto
 * efimero; contra otro equipo, una URL publica que apunte aqui).
 */
class ContractTestSuite {
  constructor({ targetBaseUrl, callbackBaseUrl, listenHost = "127.0.0.1", port = 0, confirmTimeoutMs = 10000, requestTimeoutMs = 10000, fetchImpl = fetch } = {}) {
    this.target = String(targetBaseUrl || "").replace(/\/+$/, "");
    this.callbackBaseUrl = callbackBaseUrl ? String(callbackBaseUrl).replace(/\/+$/, "") : null;
    this.listenHost = listenHost;
    this.port = port;
    this.confirmTimeoutMs = confirmTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetch = fetchImpl;
  }

  async _startHarness() {
    const confirms = [];
    const downloads = [];
    let notify = null;
    const app = express();
    app.use(express.json({ limit: "64kb" }));
    app.get("/docs/:name", (req, res) => {
      downloads.push(req.params.name);
      res.type("application/pdf").send(SAMPLE_PDF);
    });
    app.post("/confirm/:token", (req, res) => {
      confirms.push({ token: req.params.token, body: req.body });
      if (notify) notify();
      res.status(200).json({ ok: true });
    });
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(this.port, this.listenHost, () => resolve(s));
      s.on("error", reject);
    });
    const base = this.callbackBaseUrl || `http://${this.listenHost}:${server.address().port}`;
    const waitConfirm = (ms) =>
      new Promise((resolve) => {
        if (confirms.length) return resolve(true);
        const timer = setTimeout(() => resolve(false), ms);
        notify = () => {
          clearTimeout(timer);
          resolve(true);
        };
        return undefined;
      });
    return { base, confirms, downloads, waitConfirm, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
  }

  async _post(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      return { status: res.status };
    } catch (err) {
      return { status: null, error: err.name === "AbortError" ? "sin respuesta a tiempo" : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** @returns {Promise<{operador: string, cumple: boolean, obligatorios: {total, aprobados}, casos: Array}>} */
  async run() {
    const casos = [];
    const caso = (nombre, obligatorio, ok, detalle) => casos.push({ nombre, obligatorio, ok: Boolean(ok), detalle: ok ? undefined : detalle });
    const harness = await this._startHarness();
    try {
      const id = 1000000000 + crypto.randomInt(0, 899999999);
      const token = crypto.randomBytes(12).toString("hex");
      const pedido = {
        id,
        citizenName: "Ciudadano Prueba Contrato",
        citizenEmail: "contrato.ht05@example.com",
        urlDocuments: { URL1: [`${harness.base}/docs/1.pdf`], URL2: [`${harness.base}/docs/2.pdf`] },
        confirmAPI: `${harness.base}/confirm/${token}`,
      };

      // 1. Acepta un transferCitizen valido.
      const sent = await this._post(`${this.target}${TRANSFER_PATH}`, pedido);
      const accepted = sent.status >= 200 && sent.status < 300;
      caso("transferCitizen acepta un pedido valido (2xx)", true, accepted, sent.status ? `respondio ${sent.status}` : sent.error);

      // 2 a 5. Confirma en el confirmAPI que le enviamos, con el formato acordado.
      const arrived = accepted ? await harness.waitConfirm(this.confirmTimeoutMs) : false;
      caso(`confirma en el confirmAPI recibido (en menos de ${this.confirmTimeoutMs} ms)`, true, arrived, accepted ? "nunca llamo al confirmAPI" : "no se pudo iniciar la transferencia");
      const confirm = harness.confirms[0];
      caso("usa exactamente la URL de confirmAPI que recibio (con su consulta/token)", true, confirm && confirm.token === token, "llamo a otra URL de confirmacion");
      const problems = confirm ? validateConfirm(confirm.body, { expectedId: id }) : ["no hubo confirmacion"];
      caso("la confirmacion cumple {id: number, req_status: 1|0}", true, problems.length === 0, problems.join("; "));
      caso("un pedido valido se completa: req_status 1 (RNF-11)", true, confirm && confirm.body && confirm.body.req_status === 1, confirm ? `req_status ${JSON.stringify(confirm.body && confirm.body.req_status)}` : "no hubo confirmacion");
      caso("descarga los documentos antes de confirmar (directo entre operadores)", true, harness.downloads.length >= 2, `descargo ${harness.downloads.length} de 2`);

      // Recomendados: robustez que el protocolo no exige explicitamente.
      const invalid = await this._post(`${this.target}${TRANSFER_PATH}`, { ...pedido, id: String(id + 1), confirmAPI: undefined });
      caso("rechaza un transferCitizen mal formado (4xx)", false, invalid.status >= 400 && invalid.status < 500, invalid.status ? `respondio ${invalid.status}` : invalid.error);
      const ownConfirm = await this._post(`${this.target}${CONFIRM_PATH}`, { id: id + 2, req_status: 1 });
      caso("expone transferCitizenConfirm (no 404/405 ni 5xx ante un cuerpo valido)", false, ownConfirm.status && ![404, 405].includes(ownConfirm.status) && ownConfirm.status < 500, ownConfirm.status ? `respondio ${ownConfirm.status}` : ownConfirm.error);
    } finally {
      await harness.close();
    }
    const obligatorios = casos.filter((c) => c.obligatorio);
    const aprobados = obligatorios.filter((c) => c.ok).length;
    return { operador: this.target, cumple: aprobados === obligatorios.length, obligatorios: { total: obligatorios.length, aprobados }, casos };
  }
}

/** Reporte legible (para el script de consola). */
function formatReport(report) {
  const lines = [`Operador: ${report.operador}`, `Cumple el contrato: ${report.cumple ? "SI" : "NO"} (${report.obligatorios.aprobados}/${report.obligatorios.total} casos obligatorios)`, ""];
  for (const c of report.casos) lines.push(`${c.ok ? "[OK]  " : c.obligatorio ? "[FALLA]" : "[AVISO]"} ${c.nombre}${c.detalle ? ` -- ${c.detalle}` : ""}`);
  return lines.join("\n");
}

module.exports = { ContractTestSuite, formatReport, SAMPLE_PDF };
