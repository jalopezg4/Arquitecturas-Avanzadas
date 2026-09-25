const mongoose = require("mongoose");

const TIPOS = ["notaria", "universidad", "empresa", "otra"];

/**
 * Entidad institucional (RF-37): notaria, universidad, empresa... que recibe paquetes documentales en una carpeta
 * institucional propia (HU-06.2). La carpeta es un subdocumento: la entidad y su carpeta se crean en UNA sola
 * escritura atomica, asi que nunca existe una entidad sin carpeta (ni al reves).
 */
const institutionSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    tipo: { type: String, enum: TIPOS, required: true },
    // NIT sin puntos ni digito de verificacion: UNICO. Un mismo NIT no puede registrarse dos veces (409).
    // Es tambien el identificador con el que la entidad se autentica (POST /institutions/auth/token).
    nit: { type: String, required: true, unique: true },
    nitDv: { type: String, required: true },
    correoContacto: { type: String, required: true },
    telefono: { type: String, default: null },
    direccion: { type: String, default: null },
    // Credencial de la entidad (ADR-07). Argon2id, igual que el ciudadano (ADR-06); nunca la contrasena en claro.
    // `null` = la entidad se registro sin credencial y NO puede autenticarse (el registro no la exige, para no
    // cambiar el contrato de HU-06.1). Ver docs/SEGURIDAD.md, seccion 12.
    passwordHash: { type: String, default: null },
    // Proteccion contra fuerza bruta, misma politica que HU-02: el contador y el bloqueo se actualizan de forma
    // atomica en InstitutionRepository (nunca leer-modificar-guardar: dos intentos simultaneos se perderian).
    intentosFallidos: { type: Number, default: 0 },
    bloqueadoHasta: { type: Date, default: null },
    // El registro es AUTODECLARADO: nadie ha comprobado que la entidad sea quien dice ser. Este campo es la
    // AUTORIZACION para operar sobre recursos de terceros (HU-10, HU-06.3), y lo cambia unicamente el operador,
    // fuera de banda, con `npm run verify:institution` (ADR-07). Nunca desde una peticion HTTP ni desde el registro.
    //
    // NO condiciona la autenticacion (ADR-07): una entidad no verificada SI puede obtener su token, solo que ese
    // token no abre ninguna operacion sensible. Autenticacion y verificacion son conceptos independientes.
    //
    // Que significa `true`: un humano del equipo operador revisó la afiliacion y dejo constancia. NO es una
    // comprobacion automatica de existencia juridica contra una fuente externa (no hay ninguna disponible).
    verificada: { type: Boolean, default: false },
    // Trazabilidad de la decision (ADR-07): cuando, quien y por que. Se reescriben en cada verificacion o
    // revocacion, y quedan ademas en la bitacora (append-only), que conserva el historial completo.
    verificadaEn: { type: Date, default: null },
    verificadaPor: { type: String, default: null },
    motivoVerificacion: { type: String, default: null },
    carpeta: {
      id: { type: String, required: true },
      estado: { type: String, enum: ["activa"], default: "activa" },
      creadaEn: { type: Date, required: true },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Institution", institutionSchema);
module.exports.TIPOS = TIPOS;
