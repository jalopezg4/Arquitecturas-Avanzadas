const mongoose = require("mongoose");

// HU-01 AC: "La direccion unica es inmutable, con indice UNIQUE a nivel de base de datos"
// -- por eso `unique: true` en direccionUnica, no solo una validacion en el codigo de aplicacion.
const citizenSchema = new mongoose.Schema(
  {
    documento: { type: Number, required: true, unique: true },
    nombre: { type: String, required: true },
    direccion: { type: String, required: true },
    correo: { type: String, required: true },
    // HU-06.3 (RF-28): OPCIONAL a proposito -- no rompe a los ciudadanos ya registrados y el caso de estudio nunca
    // lo exige para registrarse. `null` mientras no se informe; viaja en `ciudadano.registrado` para que
    // ms-notificaciones pueda enviar SMS ademas de correo cuando exista.
    telefono: { type: String, default: null },
    // Obligatorio al registrarse (HU-01, lo exige CitizenSagaService). `null` SOLO para un ciudadano que llego
    // transferido desde otro operador (HU-05c): la contrasena no viaja entre operadores, asi que no puede iniciar
    // sesion hasta que exista un flujo para fijarla (AuthService rechaza un resumen que no sea Argon2id).
    passwordHash: { type: String, default: null },
    // Activacion de cuenta del ciudadano transferido (sin contrasena): SOLO la huella SHA-256 del codigo de un solo uso,
    // su vencimiento y cuando se envio el ultimo (limita los reenvios). Se limpian al activar.
    activacionHash: { type: String, default: null },
    activacionVenceEn: { type: Date, default: null },
    activacionEnviadaEn: { type: Date, default: null },
    // false = el ultimo codigo emitido no se confirmo en el broker (no le llego al ciudadano): ActivationReconciler
    // emite otro. true por defecto: un ciudadano sin codigo pendiente no tiene nada que reenviar.
    activacionPublicada: { type: Boolean, default: true },
    // HU-02: proteccion contra fuerza bruta. El contador y el bloqueo se actualizan de forma
    // atomica en CitizenRepository (nunca leer-modificar-guardar: dos intentos simultaneos se perderian).
    intentosFallidos: { type: Number, default: 0 },
    bloqueadoHasta: { type: Date, default: null },
    direccionUnica: { type: String, required: true, unique: true, immutable: true },
    // true cuando el broker confirmo `ciudadano.registrado`; false = hay que reenviarlo (PendingRegistrationReconciler).
    // Los ciudadanos anteriores a este campo no lo tienen y no se reenvian.
    eventoPublicado: { type: Boolean, default: false },
    // HU-05c (destino): transferencia por la que llego este ciudadano (null = se registro aqui). Solo esa transferencia
    // puede revertir su importacion.
    transferenciaOrigenId: { type: String, default: null },
    // HU-05c (destino): GovCarpeta ya lo afilio a NUESTRO operador por la importacion. Si se revierte, hay que
    // desafiliarlo; sin esta marca no se sabe si la afiliacion que ve GovCarpeta es nuestra o del operador origen.
    afiliadoPorImportacion: { type: Boolean, default: false },
    estado: {
      type: String,
      enum: ["pendiente", "activo", "transferido"],
      default: "pendiente",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Citizen", citizenSchema);
