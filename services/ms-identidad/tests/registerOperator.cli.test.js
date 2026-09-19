const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const express = require("express");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "register-operator.js");
const NEW_ID = "69d3f1a2b4c5d6e7f8091a2b";

/** Sandbox GovCarpeta FALSO: registra que le llega y puede simular fallos. Nada de esto toca el real. */
function startFakeSandbox() {
  const state = { operators: [], posts: [], gets: 0, mode: "ok", getFails: false };
  const app = express();
  app.use(express.json());
  app.get("/apis/getOperators", (_req, res) => {
    state.gets += 1;
    if (state.getFails) return res.status(500).send("failed : Application Error..");
    res.json(state.operators); // forma REAL del sandbox: _id / operatorName
  });
  app.post("/apis/registerOperator", (req, res) => {
    state.posts.push(req.body);
    const create = () => state.operators.push({ _id: NEW_ID, operatorName: req.body.name || req.body.nameOperator, participants: req.body.participants });
    switch (state.mode) {
      case "ok":
        create();
        return res.status(201).type("application/json").send(JSON.stringify(NEW_ID)); // texto plano entre comillas
      case "wrong-params":
        return res.status(501).send("failed : Wrong Parameters..");
      case "created-lost-response":
        create();
        return req.socket.destroy(); // el operador queda creado pero el cliente nunca ve la respuesta
      case "created-without-id":
        create();
        return res.status(201).send("");
      case "not-created-500":
        return res.status(500).send("failed : Application Error..");
      default:
        return res.status(500).end();
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "op-"));
});
afterEach(() => {
  sandbox.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const VALID_ENV = {
  OPERATOR_NAME: "Operador Ciudadano EAFIT",
  OPERATOR_ADDRESS: "Cra 49 # 7 Sur-50",
  OPERATOR_CONTACT_MAIL: "contacto@eafit.example",
  OPERATOR_PARTICIPANTS: "Ana Uno, Beto Dos, Caro Tres",
};

function run(args = [], env = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("OPERATOR_")) delete base[k];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...base, GOVCARPETA_BASE_URL: sandbox.url, DOTENV_PATH: path.join(tmp, "no-existe.env"), ...VALID_ENV, ...env }, timeout: 30000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr, out: stdout + stderr })
    );
  });
}

describe("HU-11 script de registro del operador (contra un sandbox falso)", () => {
  test("por defecto es una SIMULACION: consulta el directorio pero no envia ningun POST", async () => {
    const r = await run();

    expect(r.code).toBe(0);
    expect(r.out).toContain("SIMULACION");
    expect(r.out).toContain("Operador Ciudadano EAFIT");
    expect(sandbox.state.posts).toHaveLength(0);
    expect(sandbox.state.gets).toBe(1);
  });

  test("con --confirm llama a POST /apis/registerOperator una sola vez con los datos del operador", async () => {
    const r = await run(["--confirm"]);

    expect(r.code).toBe(0);
    expect(sandbox.state.posts).toHaveLength(1);
    expect(sandbox.state.posts[0]).toMatchObject({
      contactMail: "contacto@eafit.example",
      participants: ["Ana Uno", "Beto Dos", "Caro Tres"],
    });
    expect(r.stdout).toContain(`OPERATOR_ID=${NEW_ID}`); // 201 con el id como texto plano
  });

  test("por defecto envia AMBOS juegos de nombres de campo (el Swagger es inconsistente: name/address vs nameOperator/adress)", async () => {
    await run(["--confirm"]);

    expect(sandbox.state.posts[0]).toMatchObject({
      name: "Operador Ciudadano EAFIT",
      nameOperator: "Operador Ciudadano EAFIT",
      address: "Cra 49 # 7 Sur-50",
      adress: "Cra 49 # 7 Sur-50",
    });
  });

  test("--payload-style permite enviar solo un juego de nombres si el servidor rechaza el otro", async () => {
    await run(["--confirm", "--payload-style=required"]);
    expect(sandbox.state.posts[0]).toHaveProperty("nameOperator");
    expect(sandbox.state.posts[0]).toHaveProperty("adress");
    expect(sandbox.state.posts[0]).not.toHaveProperty("name");

    sandbox.state.operators.length = 0;
    await run(["--confirm", "--payload-style=properties"]);
    expect(sandbox.state.posts[1]).toHaveProperty("name");
    expect(sandbox.state.posts[1]).not.toHaveProperty("nameOperator");
  });

  test("OperatorBootstrap.register() persiste operatorId en configuracion tras 201", async () => {
    const envFile = path.join(tmp, ".env");
    fs.writeFileSync(envFile, "PORT=3001\nOPERATOR_NAME=x\n");

    const r = await run(["--confirm", `--write-env=${envFile}`]);

    expect(r.code).toBe(0);
    const content = fs.readFileSync(envFile, "utf8");
    expect(content).toContain(`OPERATOR_ID=${NEW_ID}`);
    expect(content).toContain("PORT=3001"); // no pisa el resto de la configuracion
  });

  test("OperatorBootstrap.register() falla con mensaje claro si el operador ya existe en el directorio (sin POST)", async () => {
    sandbox.state.operators.push({ _id: "68aaaaaaaaaaaaaaaaaaaaaa", operatorName: "  operador CIUDADANO eafit " });

    const r = await run(["--confirm"]);

    expect(r.code).toBe(3);
    expect(r.out).toContain("Ya existe un operador");
    expect(r.out).toContain("68aaaaaaaaaaaaaaaaaaaaaa"); // le dice cual es
    expect(r.out).toContain("No se creo un duplicado");
    expect(sandbox.state.posts).toHaveLength(0);
  });

  test("OperatorBootstrap.register() falla si el ambiente ya tiene OPERATOR_ID: no envia NADA", async () => {
    const r = await run(["--confirm"], { OPERATOR_ID: "68bbbbbbbbbbbbbbbbbbbbbb" });

    expect(r.code).toBe(3);
    expect(r.out).toContain("ya tiene un operador configurado");
    expect(sandbox.state.posts).toHaveLength(0);
    expect(sandbox.state.gets).toBe(0);
  });

  test("con SOLO OPERATOR_ID en el entorno (ambiente desplegado) responde exit 3 sin red, no exit 2 por campos ausentes", async () => {
    const r = await run(["--confirm"], { OPERATOR_ID: "68bbbbbbbbbbbbbbbbbbbbbb", OPERATOR_NAME: "", OPERATOR_ADDRESS: "", OPERATOR_CONTACT_MAIL: "", OPERATOR_PARTICIPANTS: "" });

    expect(r.code).toBe(3);
    expect(sandbox.state.gets + sandbox.state.posts.length).toBe(0);
  });

  test("un integrante vacio en la lista (\"Ana,,Beto\") se rechaza en vez de ignorarse en silencio", async () => {
    const r = await run(["--confirm"], { OPERATOR_PARTICIPANTS: "Ana,,Beto" });

    expect(r.code).toBe(2);
    expect(r.out).toContain("OPERATOR_PARTICIPANTS");
    expect(sandbox.state.posts).toHaveLength(0);
  });

  test("el .env.example con la direccion de ejemplo se carga COMPLETA (el # no la corta)", () => {
    const parsed = require("dotenv").parse(fs.readFileSync(path.resolve(__dirname, "..", ".env.example"), "utf8"));
    expect(parsed.OPERATOR_ADDRESS).toBe("Carrera 49 # 7 Sur-50, Medellin");
  });

  test("datos incompletos o invalidos: exit 2, mensaje claro y ninguna llamada", async () => {
    const r = await run(["--confirm"], { OPERATOR_CONTACT_MAIL: "no-es-correo", OPERATOR_PARTICIPANTS: "" });

    expect(r.code).toBe(2);
    expect(r.out).toContain("OPERATOR_CONTACT_MAIL");
    expect(r.out).toContain("OPERATOR_PARTICIPANTS");
    expect(sandbox.state.gets + sandbox.state.posts.length).toBe(0);
  });

  test("501 Wrong Parameters: explica la inconsistencia del Swagger y sugiere --payload-style", async () => {
    sandbox.state.mode = "wrong-params";

    const r = await run(["--confirm"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("--payload-style");
    expect(r.out).toContain("No se creo ningun operador");
    expect(sandbox.state.posts).toHaveLength(1); // sin reintentos
  });

  test("respuesta PERDIDA tras crearse el operador: lo recupera del directorio y NO reintenta (no duplica)", async () => {
    sandbox.state.mode = "created-lost-response";

    const r = await run(["--confirm"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("se recupero del directorio");
    expect(r.stdout).toContain(`OPERATOR_ID=${NEW_ID}`);
    expect(sandbox.state.posts).toHaveLength(1);
    expect(sandbox.state.operators).toHaveLength(1);
  });

  test("201 sin un id utilizable: no guarda basura en .env y recupera el id real del directorio", async () => {
    sandbox.state.mode = "created-without-id";
    const envFile = path.join(tmp, ".env");

    const r = await run(["--confirm", `--write-env=${envFile}`]);

    expect(r.code).toBe(0);
    expect(fs.readFileSync(envFile, "utf8")).toBe(`OPERATOR_ID=${NEW_ID}\n`);
    expect(sandbox.state.posts).toHaveLength(1);
  });

  test("fallo del servidor que NO creo nada: avisa que no se reintente a ciegas y no escribe .env", async () => {
    sandbox.state.mode = "not-created-500";
    const envFile = path.join(tmp, ".env");

    const r = await run(["--confirm", `--write-env=${envFile}`]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("NO lo reintentes a ciegas");
    expect(fs.existsSync(envFile)).toBe(false);
    expect(sandbox.state.posts).toHaveLength(1);
  });

  test("si no se puede consultar el directorio, NO registra nada (no se puede descartar un duplicado)", async () => {
    sandbox.state.getFails = true;

    const r = await run(["--confirm"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("no se registro nada");
    expect(sandbox.state.posts).toHaveLength(0);
  });
});

describe("HU-11: se ejecuta una sola vez por ambiente, no en cada arranque", () => {
  test("el arranque del servicio no registra operadores (es un script aparte)", () => {
    const server = fs.readFileSync(path.resolve(__dirname, "..", "src", "server.js"), "utf8");
    expect(server).not.toMatch(/registerOperator|OperatorBootstrap/);
  });

  test("el servicio avisa al arrancar sin OPERATOR_ID e indica como registrarlo", () => {
    const server = fs.readFileSync(path.resolve(__dirname, "..", "src", "server.js"), "utf8");
    expect(server).toContain("npm run register:operator");
  });
});
