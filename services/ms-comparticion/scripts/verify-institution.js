#!/usr/bin/env node
/**
 * ADR-07 -- Verificacion de una entidad institucional por el OPERADOR, fuera de banda.
 *
 *   npm run verify:institution -- --nit=890901389
 *       simulacion: localiza la entidad y muestra que quedaria escrito. NO modifica nada.
 *   npm run verify:institution -- --nit=890901389 --confirm --motivo="carta membretada + correo del dominio"
 *       marca la entidad como VERIFICADA: podra ejecutar operaciones institucionales sensibles (HU-10).
 *   npm run verify:institution -- --nit=890901389 --revoke --confirm --motivo="cese de convenio"
 *       revoca la verificacion.
 *
 * Que significa verificar: que un humano del equipo operador reviso la afiliacion y deja constancia. NO es una
 * comprobacion automatica de existencia juridica contra una fuente externa (no hay ninguna disponible: GovCarpeta
 * no conoce instituciones y el RUES/DIAN no esta en el alcance). El NIT se valida por su digito de verificacion,
 * que es aritmetica, no existencia.
 *
 * Por que un script y no una ruta HTTP: asi la operacion no es alcanzable desde fuera (el gateway solo enruta lo
 * que declara su lista blanca) y exige acceso al despliegue. Una entidad no puede verificarse a si misma.
 *
 * Opciones: --nit=<nit>  --confirm  --revoke  --motivo="..."  --por="Nombre Apellido"
 *   --por: quien toma la decision. Si se omite, VERIFICATION_DECIDED_BY o el usuario del sistema operativo.
 * Datos: MONGO_URI (la base de ms-comparticion), NODE_ENV.
 * Salida: 0 ok | 1 error | 2 datos invalidos / uso / la entidad no existe | 3 ya estaba en ese estado (no se escribio nada)
 */
const os = require("os");
const path = require("path");
require("dotenv").config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const env = require("../src/config/env");
const { InstitutionRepository } = require("../src/infrastructure/InstitutionRepository");
const AuditRepository = require("../src/infrastructure/AuditRepository");
const AuditLogger = require("../src/infrastructure/AuditLogger");
const { runWithTrace, newTraceId } = require("../src/tracing/TraceContext");
const { InstitutionService, ValidationError, InstitutionNotFoundError, AlreadyInStateError } = require("../src/application/InstitutionService");

const KNOWN = ["--confirm", "--revoke"];
const KNOWN_WITH_VALUE = ["nit", "motivo", "por"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

function describe(institucion) {
  return {
    institutionId: institucion.institutionId,
    nombre: institucion.nombre,
    nit: institucion.nit,
    verificada: institucion.verificada,
    verificadaEn: institucion.verificadaEn,
    verificadaPor: institucion.verificadaPor,
    motivoVerificacion: institucion.motivoVerificacion,
  };
}

async function main() {
  const unknown = args.filter((a) => !KNOWN.includes(a) && !KNOWN_WITH_VALUE.some((k) => a.startsWith(`--${k}=`)));
  if (unknown.length) {
    console.error(`Opcion desconocida: ${unknown.join(" ")} (validas: --nit=<nit>, --confirm, --revoke, --motivo="...", --por="...")`);
    return 2;
  }

  const confirm = flag("confirm");
  const revoke = flag("revoke");
  const decididaPor = value("por") || process.env.VERIFICATION_DECIDED_BY || (os.userInfo().username || "");
  const input = { nit: value("nit"), decididaPor, motivo: value("motivo") };

  await mongoose.connect(env.mongoUri);
  try {
    const service = new InstitutionService({
      institutionRepository: new InstitutionRepository(),
      auditLogger: new AuditLogger({ auditRepository: new AuditRepository() }),
    });

    const operacion = revoke ? "revokeVerification" : "verify";
    const result = await service[operacion](input, { dryRun: !confirm });

    if (result.status === "dry-run") {
      console.log(`SIMULACION (no se escribio nada). Se ${revoke ? "REVOCARIA la verificacion de" : "VERIFICARIA"} esta entidad:`);
      console.log(JSON.stringify(describe(result.institucion), null, 2));
      console.log(`Quedaria: verificada=${!revoke}, verificadaPor="${decididaPor}", con la fecha de ejecucion y el motivo que se indique.`);
      if (!input.motivo) console.log("Ojo: --motivo es OBLIGATORIO con --confirm (es la evidencia de la revision).");
      console.log(
        revoke
          ? `Para revocarla de verdad: npm run verify:institution -- --nit=${input.nit} --revoke --confirm --motivo="..."`
          : `Para verificarla de verdad: npm run verify:institution -- --nit=${input.nit} --confirm --motivo="..."`
      );
      return 0;
    }

    console.log(revoke ? "Verificacion REVOCADA." : "Entidad VERIFICADA.");
    console.log(JSON.stringify(describe(result.institucion), null, 2));
    console.log(
      revoke
        ? "La entidad puede seguir autenticandose, pero ya no puede ejecutar operaciones institucionales sensibles (HU-10)."
        : "La entidad ya puede ejecutar operaciones institucionales sensibles (HU-10), siempre que ademas se autentique."
    );
    // El token institucional vive 15 minutos y lleva el estado de verificacion del momento en que se emitio.
    console.log("Aviso: los tokens institucionales ya emitidos conservan el estado anterior hasta que expiren (15 minutos).");
    return 0;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

// El trace-id enlaza la entrada de bitacora con las lineas de log de esta ejecucion (HT-06), igual que en una peticion.
runWithTrace(newTraceId(), main)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err.message);
    if (err instanceof ValidationError || err instanceof InstitutionNotFoundError) process.exit(2);
    if (err instanceof AlreadyInStateError) process.exit(3);
    process.exit(1);
  });
