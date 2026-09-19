const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  OperatorBootstrap,
  OperatorInputError,
  OperatorAlreadyRegisteredError,
  OperatorRegistrationError,
} = require("../src/application/OperatorBootstrap");
const { upsertEnvVar } = require("../src/config/envFile");

const data = { name: "  Mi Operador ", address: " Cra 1 ", contactMail: "a@a.com", participants: [" Ana ", "Beto"] };

function makeClient({ operators = [], registerImpl } = {}) {
  return {
    listOperators: jest.fn(async () => operators),
    registerOperator: jest.fn(registerImpl || (async () => ({ operatorId: "69d3f1a2b4c5d6e7f8091a2b" }))),
  };
}

describe("OperatorBootstrap.validate()", () => {
  test("acepta datos completos", () => {
    expect(OperatorBootstrap.validate(data)).toEqual([]);
  });

  test("informa todos los problemas a la vez", () => {
    const problems = OperatorBootstrap.validate({ name: " ", address: "", contactMail: "x", participants: [] });
    expect(problems).toHaveLength(4);
  });

  test("rechaza integrantes vacios en la lista", () => {
    expect(OperatorBootstrap.validate({ ...data, participants: ["Ana", "  "] })).toHaveLength(1);
  });
});

describe("OperatorBootstrap.register()", () => {
  test("registra y devuelve el operatorId, enviando los datos sin espacios sobrantes", async () => {
    const client = makeClient();

    const result = await new OperatorBootstrap({ govCarpetaClient: client }).register(data);

    expect(result).toMatchObject({ status: "registered", operatorId: "69d3f1a2b4c5d6e7f8091a2b" });
    expect(client.registerOperator).toHaveBeenCalledWith(
      { name: "Mi Operador", address: "Cra 1", contactMail: "a@a.com", participants: ["Ana", "Beto"] },
      expect.anything()
    );
  });

  test("dryRun valida y consulta el directorio pero NO llama a registerOperator", async () => {
    const client = makeClient();

    const result = await new OperatorBootstrap({ govCarpetaClient: client }).register(data, { dryRun: true });

    expect(result.status).toBe("dry-run");
    expect(client.listOperators).toHaveBeenCalled();
    expect(client.registerOperator).not.toHaveBeenCalled();
  });

  test("con OPERATOR_ID ya configurado falla sin consultar ni enviar nada", async () => {
    const client = makeClient();

    await expect(new OperatorBootstrap({ govCarpetaClient: client }).register(data, { currentOperatorId: "68bbbbbbbbbbbbbbbbbbbbbb" })).rejects.toThrow(
      OperatorAlreadyRegisteredError
    );
    expect(client.listOperators).not.toHaveBeenCalled();
    expect(client.registerOperator).not.toHaveBeenCalled();
  });

  test("falla con mensaje claro si el nombre ya existe (sin distinguir mayusculas ni espacios) y no crea duplicado", async () => {
    const client = makeClient({ operators: [{ id: "68aaaaaaaaaaaaaaaaaaaaaa", name: "MI operador" }] });

    const err = await new OperatorBootstrap({ govCarpetaClient: client }).register(data).catch((e) => e);

    expect(err).toBeInstanceOf(OperatorAlreadyRegisteredError);
    expect(err.operatorId).toBe("68aaaaaaaaaaaaaaaaaaaaaa");
    expect(err.message).toContain("No se creo un duplicado");
    expect(client.registerOperator).not.toHaveBeenCalled();
  });

  test("un operador con OTRO nombre no bloquea el registro", async () => {
    const client = makeClient({ operators: [{ id: "68aaaaaaaaaaaaaaaaaaaaaa", name: "Carpeta Ciudadana" }] });

    const result = await new OperatorBootstrap({ govCarpetaClient: client }).register(data);

    expect(result.status).toBe("registered");
  });

  test("datos invalidos lanzan OperatorInputError sin llamar al cliente", async () => {
    const client = makeClient();

    await expect(new OperatorBootstrap({ govCarpetaClient: client }).register({ ...data, contactMail: "x" })).rejects.toThrow(OperatorInputError);
    expect(client.listOperators).not.toHaveBeenCalled();
  });

  test("si el directorio no se puede consultar, no registra (no se puede descartar un duplicado)", async () => {
    const client = makeClient();
    client.listOperators.mockRejectedValue(new Error("timeout"));

    await expect(new OperatorBootstrap({ govCarpetaClient: client }).register(data)).rejects.toThrow(OperatorRegistrationError);
    expect(client.registerOperator).not.toHaveBeenCalled();
  });

  test("501 no intenta recuperar del directorio: fue un rechazo definitivo", async () => {
    const client = makeClient({ registerImpl: async () => Promise.reject(Object.assign(new Error("501"), { response: { status: 501 } })) });

    await expect(new OperatorBootstrap({ govCarpetaClient: client }).register(data)).rejects.toThrow(/payload-style/);
    expect(client.listOperators).toHaveBeenCalledTimes(1); // solo la comprobacion previa de duplicados
  });
});

describe("upsertEnvVar()", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("crea el archivo si no existe", () => {
    const f = path.join(dir, ".env");
    expect(upsertEnvVar(f, "OPERATOR_ID", "abc123def")).toEqual({ created: true, replaced: false });
    expect(fs.readFileSync(f, "utf8")).toBe("OPERATOR_ID=abc123def\n");
  });

  test("reemplaza el valor existente y conserva las demas lineas y comentarios", () => {
    const f = path.join(dir, ".env");
    fs.writeFileSync(f, "# config\nPORT=3001\nOPERATOR_ID=viejo\nJWT_SECRET=x\n");

    expect(upsertEnvVar(f, "OPERATOR_ID", "nuevo").replaced).toBe(true);

    expect(fs.readFileSync(f, "utf8")).toBe("# config\nPORT=3001\nOPERATOR_ID=nuevo\nJWT_SECRET=x\n");
  });

  test("agrega la variable al final si no estaba, respetando fin de linea CRLF", () => {
    const f = path.join(dir, ".env");
    fs.writeFileSync(f, "PORT=3001\r\nNODE_ENV=development\r\n");

    upsertEnvVar(f, "OPERATOR_ID", "nuevo");

    expect(fs.readFileSync(f, "utf8")).toBe("PORT=3001\r\nNODE_ENV=development\r\nOPERATOR_ID=nuevo\r\n");
  });

  test("no confunde una variable con prefijo parecido (OPERATOR_ID_OLD)", () => {
    const f = path.join(dir, ".env");
    fs.writeFileSync(f, "OPERATOR_ID_OLD=keep\n");

    upsertEnvVar(f, "OPERATOR_ID", "nuevo");

    expect(fs.readFileSync(f, "utf8")).toBe("OPERATOR_ID_OLD=keep\nOPERATOR_ID=nuevo\n");
  });

  test("rechaza nombres de variable invalidos y valores con saltos de linea (inyeccion de otra variable)", () => {
    const f = path.join(dir, ".env");
    expect(() => upsertEnvVar(f, "operator id", "x")).toThrow(/invalido/);
    expect(() => upsertEnvVar(f, "OPERATOR_ID", "x\nJWT_SECRET=pwned")).toThrow(/saltos de linea/);
    expect(fs.existsSync(f)).toBe(false);
  });
});
