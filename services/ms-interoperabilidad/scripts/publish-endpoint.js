#!/usr/bin/env node
/**
 * HU-05b -- Publicacion del endpoint de transferencia del operador ante MinTIC (RF-35).
 *
 *   npm run publish:endpoint                       simulacion: valida, consulta el directorio y muestra que enviaria
 *   npm run publish:endpoint -- --confirm          publica DE VERDAD (modifica el registro de nuestro operador en GovCarpeta)
 *   npm run publish:endpoint -- --confirm --replace  reemplaza una direccion que ya estaba publicada (decision explicita)
 *
 * Datos (variables de entorno o .env): OPERATOR_ID (de HU-11), PUBLIC_BASE_URL (p. ej. https://mifolio.example.co; se
 *   publican <base>/api/transferCitizen y <base>/api/transferCitizenConfirm) o bien TRANSFER_ENDPOINT_URL y
 *   TRANSFER_CONFIRM_URL, GOVCARPETA_BASE_URL. Fuera de local NO se aceptan direcciones privadas ni localhost: las veran
 *   otros operadores. En desarrollo local, ALLOW_PRIVATE_OPERATOR_URLS=true lo permite.
 * Salida: 0 ok | 1 error | 2 datos invalidos / uso / falta el operatorId | 3 ya estaba publicado (no se envio nada)
 */
const path = require("path");
require("dotenv").config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, "..", ".env") });

const { GovCarpetaDirectoryClient } = require("../src/infrastructure/GovCarpetaDirectoryClient");
const GovCarpetaEndpointClient = require("../src/infrastructure/GovCarpetaEndpointClient");
const { EndpointRegistrationService, EndpointInputError, OperatorNotRegisteredError, AlreadyPublishedError, PublicationError } = require("../src/application/EndpointRegistrationService");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);

async function main() {
  const unknown = args.filter((a) => !["--confirm", "--replace"].includes(a));
  if (unknown.length) {
    console.error(`Opcion desconocida: ${unknown.join(" ")} (validas: --confirm, --replace)`);
    return 2;
  }
  const confirm = flag("confirm");
  const baseUrl = process.env.GOVCARPETA_BASE_URL || "https://govcarpeta-apis-4905ff3c005b.herokuapp.com";
  const service = new EndpointRegistrationService({
    directoryClient: new GovCarpetaDirectoryClient({ baseUrl }),
    endpointClient: new GovCarpetaEndpointClient({ baseUrl }),
    urlPolicy: { allowPrivate: process.env.ALLOW_PRIVATE_OPERATOR_URLS === "true" },
  });

  const result = await service.publish(
    {
      operatorId: process.env.OPERATOR_ID,
      baseUrl: process.env.PUBLIC_BASE_URL,
      endPoint: process.env.TRANSFER_ENDPOINT_URL,
      endPointConfirm: process.env.TRANSFER_CONFIRM_URL,
    },
    { dryRun: !confirm, replace: flag("replace") }
  );

  if (result.status === "dry-run") {
    console.log(`SIMULACION (no se envio nada). Se publicaria en ${baseUrl}:`);
    console.log(JSON.stringify(result.payload, null, 2));
    if (result.replacing) console.log("Ojo: REEMPLAZARIA la direccion que ya esta publicada (--replace).");
    console.log("Ojo: otros operadores empezaran a enviar transferencias a esa direccion. Publicala cuando el endpoint ya este en linea.");
    console.log("Para publicar de verdad: npm run publish:endpoint -- --confirm");
    return 0;
  }

  console.log(result.status === "recovered" ? "La publicacion ya se habia aplicado (se comprobo en el directorio)." : "Endpoint publicado.");
  console.log(JSON.stringify(result.payload, null, 2));
  if (!result.verified) console.log("Aviso: GovCarpeta acepto la publicacion, pero el directorio aun no la refleja. Vuelve a consultar GET /apis/getOperators en unos minutos.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err.message);
    if (err instanceof EndpointInputError || err instanceof OperatorNotRegisteredError) process.exit(2);
    if (err instanceof AlreadyPublishedError) process.exit(3);
    if (err instanceof PublicationError) process.exit(1);
    process.exit(1);
  });
