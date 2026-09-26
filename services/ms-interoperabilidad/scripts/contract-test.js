#!/usr/bin/env node
/**
 * HT-05: corre la suite de contrato del protocolo de transferencia contra un operador.
 *
 *   npm run test:contract -- --target=https://otro-operador.example.co [--callback=https://mi-tunel.example.co] [--port=4010]
 *   npm run test:contract -- --reference     # contra el operador de referencia en memoria (demostracion)
 *
 * --callback: URL PUBLICA con la que el operador bajo prueba alcanza este proceso (descarga de documentos de prueba y
 * confirmacion). Contra otro equipo hace falta exponer --port a internet (p. ej. un tunel); en local no.
 *
 * No toca GovCarpeta ni datos reales: el ciudadano y los documentos son de prueba. OJO: un operador real del curso
 * podria registrar ese ciudadano de prueba en GovCarpeta al recibirlo; coordinar antes con el otro equipo.
 *
 * Codigos de salida: 0 cumple · 1 no cumple (algun caso obligatorio fallo) · 2 uso invalido.
 */
const { ContractTestSuite, formatReport } = require("../src/contract/ContractTestSuite");
const { createReferenceOperator } = require("../src/contract/ReferenceOperator");

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
}

async function main() {
  let target = arg("target") || process.env.CONTRACT_TARGET_URL;
  let reference = null;
  if (arg("reference")) {
    const { app } = createReferenceOperator();
    reference = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    target = `http://127.0.0.1:${reference.address().port}`;
  }
  if (!target || !/^https?:\/\//.test(target)) {
    console.error("Uso: npm run test:contract -- --target=<url base del operador> [--callback=<url publica>] [--port=<puerto>] | --reference");
    return 2;
  }
  const suite = new ContractTestSuite({
    targetBaseUrl: target,
    callbackBaseUrl: arg("callback") || process.env.CONTRACT_CALLBACK_BASE_URL,
    listenHost: arg("callback") ? "0.0.0.0" : "127.0.0.1",
    port: Number(arg("port") || process.env.CONTRACT_PORT || 0),
    confirmTimeoutMs: Number(process.env.CONTRACT_CONFIRM_TIMEOUT_MS || 60000),
  });
  try {
    const report = await suite.run();
    console.log(formatReport(report));
    return report.cumple ? 0 : 1;
  } finally {
    if (reference) {
      reference.closeAllConnections();
      await new Promise((r) => reference.close(r));
    }
  }
}

if (require.main === module) {
  // exitCode (y no process.exit): deja que los sockets terminen de cerrarse antes de salir.
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = { main };
