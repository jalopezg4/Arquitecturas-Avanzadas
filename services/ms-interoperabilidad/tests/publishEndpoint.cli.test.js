const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const express = require("express");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "publish-endpoint.js");
const OWN = "6aae9153b7655900026073f1";
const PUBLIC = "https://mifolio.operadores.co";

/** Sandbox GovCarpeta FALSO: guarda lo que le llega y puede simular fallos. Nada de esto toca el real. */
function startFakeSandbox() {
  const state = { operators: [], puts: [], gets: 0, mode: "ok", getFails: false, applyOnPut: true };
  const app = express();
  app.use(express.json());
  app.get("/apis/getOperators", (_req, res) => {
    state.gets += 1;
    if (state.getFails) return res.status(500).send("failed : Application Error..");
    res.json(state.operators); // forma REAL del sandbox: _id / operatorName / transferAPIURL
  });
  app.put("/apis/registerTransferEndPoint", (req, res) => {
    state.puts.push(req.body);
    const apply = () => {
      const me = state.operators.find((o) => o._id === req.body.idOperator);
      if (me) me.transferAPIURL = ` ${req.body.endPoint}`; // con el espacio inicial que trae el sandbox real
    };
    switch (state.mode) {
      case "ok":
        apply();
        return res.status(201).send("Updated");
      case "wrong-params":
        return res.status(501).send("failed : Wrong Parameters..");
      case "applied-lost-response":
        apply();
        return req.socket.destroy(); // se aplico, pero el cliente nunca ve la respuesta
      case "accepted-not-reflected":
        return res.status(201).send("Updated"); // acepta pero el directorio no lo refleja
      default:
        return res.status(500).send("failed : Application Error..");
    }
  });
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

let sandbox;
let tmp;
beforeEach(async () => {
  sandbox = await startFakeSandbox();
  sandbox.state.operators = [
    { _id: "690d4e0e8502c8000221a5a7", operatorName: "Carpeta Ciudadana", transferAPIURL: " http://carpeta.operadores.co/api/transferCitizen" },
    { _id: OWN, operatorName: "MiFolio", participants: ["a"] },
  ];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-"));
});
afterEach(() => {
  sandbox.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args = [], env = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(OPERATOR_ID|PUBLIC_BASE_URL|TRANSFER_|ALLOW_PRIVATE)/.test(k)) delete base[k];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...base, GOVCARPETA_BASE_URL: sandbox.url, DOTENV_PATH: path.join(tmp, "no-existe.env"), OPERATOR_ID: OWN, PUBLIC_BASE_URL: PUBLIC, ...env }, timeout: 30000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr, out: stdout + stderr })
    );
  });
}
const noSuchOperator = { OPERATOR_ID: "ffffffffffffffffffffffff" };

describe("HU-05b script de publicacion del endpoint (contra un sandbox falso)", () => {
  test("por defecto es una SIMULACION: consulta el directorio pero NO envia ningun PUT", async () => {
    const r = await run();

    expect(r.code).toBe(0);
    expect(r.out).toContain("SIMULACION");
    expect(r.out).toContain(`${PUBLIC}/api/transferCitizen`);
    expect(r.out).toContain(`${PUBLIC}/api/transferCitizenConfirm`);
    expect(sandbox.state.puts).toHaveLength(0);
    expect(sandbox.state.gets).toBe(1);
  });

  test("con --confirm llama a PUT /apis/registerTransferEndPoint UNA vez con {idOperator, endPoint, endPointConfirm}", async () => {
    const r = await run(["--confirm"]);

    expect(r.code).toBe(0);
    expect(sandbox.state.puts).toEqual([{ idOperator: OWN, endPoint: `${PUBLIC}/api/transferCitizen`, endPointConfirm: `${PUBLIC}/api/transferCitizenConfirm` }]);
    expect(r.stdout).toContain("Endpoint publicado");
    expect(r.stdout).not.toContain("aun no la refleja"); // la verificacion en el directorio salio bien
  });

  test("EndpointRegistrationService.publish() falla si el endpoint ya esta publicado: exit 3, mensaje claro y ningun PUT", async () => {
    await run(["--confirm"]);
    sandbox.state.puts.length = 0;

    const r = await run(["--confirm"]);

    expect(r.code).toBe(3);
    expect(r.out).toContain("ya tiene una direccion de transferencia publicada");
    expect(r.out).toContain("misma que se iba a publicar");
    expect(sandbox.state.puts).toHaveLength(0);
  });

  test("--replace permite reemplazar una direccion ya publicada", async () => {
    await run(["--confirm"]);
    sandbox.state.puts.length = 0;

    const r = await run(["--confirm", "--replace"], { PUBLIC_BASE_URL: "https://nuevo.operadores.co" });

    expect(r.code).toBe(0);
    expect(sandbox.state.puts[0].endPoint).toBe("https://nuevo.operadores.co/api/transferCitizen");
  });

  test("EndpointRegistrationService.publish() requiere operatorId existente: sin OPERATOR_ID, exit 2 y mensaje que remite a HU-11", async () => {
    const r = await run(["--confirm"], { OPERATOR_ID: "" });

    expect(r.code).toBe(2);
    expect(r.out).toContain("registra primero el operador");
    expect(sandbox.state.gets + sandbox.state.puts.length).toBe(0);
  });

  test("un OPERATOR_ID que no esta en el directorio: exit 2 y no se publica", async () => {
    const r = await run(["--confirm"], noSuchOperator);

    expect(r.code).toBe(2);
    expect(r.out).toContain("no existe en el directorio");
    expect(sandbox.state.puts).toHaveLength(0);
  });

  test("direcciones internas (localhost) se rechazan: exit 2 y ninguna llamada; con ALLOW_PRIVATE_OPERATOR_URLS=true se permiten (solo desarrollo)", async () => {
    const blocked = await run(["--confirm"], { PUBLIC_BASE_URL: "http://localhost:3004" });
    expect(blocked.code).toBe(2);
    expect(blocked.out).toContain("endPoint:");
    expect(sandbox.state.gets + sandbox.state.puts.length).toBe(0);

    const dev = await run(["--confirm"], { PUBLIC_BASE_URL: "http://localhost:3004", ALLOW_PRIVATE_OPERATOR_URLS: "true" });
    expect(dev.code).toBe(0);
  });

  test("las dos direcciones se pueden dar por separado", async () => {
    const r = await run(["--confirm"], { PUBLIC_BASE_URL: "", TRANSFER_ENDPOINT_URL: "https://x.co/recibir", TRANSFER_CONFIRM_URL: "https://x.co/confirmar" });
    expect(r.code).toBe(0);
    expect(sandbox.state.puts[0]).toMatchObject({ endPoint: "https://x.co/recibir", endPointConfirm: "https://x.co/confirmar" });
  });

  test("una opcion desconocida (typo) se rechaza en vez de ignorarse: exit 2, sin llamadas", async () => {
    const r = await run(["--confirmar"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Opcion desconocida");
    expect(sandbox.state.gets).toBe(0);
  });

  test("501 Wrong Parameters: exit 1, 'no se cambio nada', un solo PUT", async () => {
    sandbox.state.mode = "wrong-params";

    const r = await run(["--confirm"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("rechazo la publicacion (501)");
    expect(r.out).toContain("No se cambio nada");
    expect(sandbox.state.puts).toHaveLength(1);
  });

  test("respuesta PERDIDA tras aplicarse: lo detecta releyendo el directorio (exit 0, 'ya se habia aplicado')", async () => {
    sandbox.state.mode = "applied-lost-response";

    const r = await run(["--confirm"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ya se habia aplicado");
    expect(sandbox.state.puts.length).toBeGreaterThanOrEqual(1);
  });

  test("500 persistente sin aplicarse: exit 1 y manda a revisar el directorio", async () => {
    sandbox.state.mode = "server-error";

    const r = await run(["--confirm"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("No se pudo confirmar");
    expect(sandbox.state.puts).toHaveLength(3); // 3 intentos de una ACTUALIZACION idempotente
  });

  test("GovCarpeta acepta pero el directorio aun no lo refleja: exit 0 con un aviso (no un error)", async () => {
    sandbox.state.mode = "accepted-not-reflected";

    const r = await run(["--confirm"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aun no la refleja");
  });

  test("si no se puede consultar el directorio, NO publica nada (exit 1)", async () => {
    sandbox.state.getFails = true;

    const r = await run(["--confirm"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("no se publico nada");
    expect(sandbox.state.puts).toHaveLength(0);
  });
});

describe("HU-05b: se ejecuta una sola vez por ambiente, no en cada arranque", () => {
  test("el arranque del servicio NO publica endpoints (es un script aparte)", () => {
    const server = fs.readFileSync(path.resolve(__dirname, "..", "src", "server.js"), "utf8");
    expect(server).not.toMatch(/registerTransferEndPoint|EndpointRegistration|GovCarpetaEndpointClient/);
  });

  test("el servicio de directorio (solo lectura) no importa el cliente que escribe", () => {
    const dir = fs.readFileSync(path.resolve(__dirname, "..", "src", "application", "OperatorDirectoryService.js"), "utf8");
    const readClient = fs.readFileSync(path.resolve(__dirname, "..", "src", "infrastructure", "GovCarpetaDirectoryClient.js"), "utf8");
    expect(dir).not.toMatch(/EndpointClient|registerTransferEndPoint/);
    expect(readClient).not.toMatch(/\.put\(|\.post\(|\.delete\(/);
  });
});
