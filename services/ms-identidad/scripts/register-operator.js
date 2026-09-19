#!/usr/bin/env node
/**
 * HU-11 -- Registro del operador en el ecosistema MinTIC (RF-34).
 *
 *   npm run register:operator                       simulacion: valida, consulta el directorio y muestra que enviaria
 *   npm run register:operator -- --confirm          registra DE VERDAD (crea un registro permanente y compartido)
 *   npm run register:operator -- --confirm --write-env    ademas guarda OPERATOR_ID en .env
 *
 * Opciones: --payload-style=union|properties|required   --write-env[=ruta]
 * Datos: OPERATOR_NAME, OPERATOR_ADDRESS, OPERATOR_CONTACT_MAIL, OPERATOR_PARTICIPANTS (separados por coma),
 *        GOVCARPETA_BASE_URL. Si OPERATOR_ID ya esta definido, no hace nada.
 * Salida: 0 ok | 1 error | 2 datos invalidos / uso | 3 el operador ya existia (no se envio nada)
 */
const path = require("path");
require("dotenv").config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, "..", ".env") });
const axios = require("axios");

const GovCarpetaClient = require("../src/infrastructure/GovCarpetaClient");
const {
  OperatorBootstrap,
  OperatorInputError,
  OperatorAlreadyRegisteredError,
  OperatorRegistrationError,
} = require("../src/application/OperatorBootstrap");
const { upsertEnvVar } = require("../src/config/envFile");

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

async function main() {
  const confirm = flag("confirm");
  const payloadStyle = value("payload-style");
  if (payloadStyle && !["union", "properties", "required"].includes(payloadStyle)) {
    console.error("--payload-style debe ser union, properties o required");
    return 2;
  }

  const data = {
    name: process.env.OPERATOR_NAME,
    address: process.env.OPERATOR_ADDRESS,
    contactMail: process.env.OPERATOR_CONTACT_MAIL,
    participants: (process.env.OPERATOR_PARTICIPANTS || "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  const baseUrl = process.env.GOVCARPETA_BASE_URL || "https://govcarpeta-apis-4905ff3c005b.herokuapp.com";
  const client = new GovCarpetaClient({ baseUrl, http: axios.create({ timeout: 30000 }) });

  const bootstrap = new OperatorBootstrap({ govCarpetaClient: client });
  const result = await bootstrap.register(data, {
    currentOperatorId: process.env.OPERATOR_ID,
    dryRun: !confirm,
    payloadStyle,
  });

  if (result.status === "dry-run") {
    console.log("SIMULACION (no se envio nada). Se registraria este operador en " + baseUrl + ":");
    console.log(JSON.stringify(result.payload, null, 2));
    console.log("El nombre no existe en el directorio. Ojo: el registro es permanente y visible para todos los equipos (no hay borrado).");
    console.log("Para registrarlo de verdad: npm run register:operator -- --confirm --write-env");
    return 0;
  }

  const recovered = result.status === "recovered";
  console.log(recovered ? "El registro ya se habia creado (se recupero del directorio)." : "Operador registrado.");
  console.log(`OPERATOR_ID=${result.operatorId}`);

  if (flag("write-env")) {
    const target = value("write-env") || path.resolve(__dirname, "..", ".env");
    upsertEnvVar(target, "OPERATOR_ID", result.operatorId);
    console.log(`Guardado en ${target} (archivo ignorado por git).`);
  } else {
    console.log("Guardalo como variable de entorno / secreto del ambiente: OPERATOR_ID (o vuelve a ejecutar con --write-env).");
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err.message);
    if (err instanceof OperatorInputError) process.exit(2);
    if (err instanceof OperatorAlreadyRegisteredError) process.exit(3);
    if (err instanceof OperatorRegistrationError) process.exit(1);
    process.exit(1);
  });
