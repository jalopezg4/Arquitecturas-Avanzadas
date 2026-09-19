const mongoose = require("mongoose");

const OUTCOMES = ["exito", "fallo", "rechazo"];
const ACTOR_TYPES = ["ciudadano", "entidad", "sistema"];

const auditEntrySchema = new mongoose.Schema(
  {
    actor: { type: String, required: true },
    actorType: { type: String, enum: ACTOR_TYPES, default: "ciudadano" },
    action: { type: String, required: true },
    resource: { type: String },
    // Dueno del recurso accedido; permite detectar accesos a recursos ajenos (RNF-07).
    resourceOwner: { type: String },
    // true cuando un tercero actua legitimamente sobre recursos ajenos (ej. entidad emisora
    // entregando un documento, envio autorizado por el ciudadano). No cuenta como violacion.
    delegated: { type: Boolean, default: false },
    outcome: { type: String, enum: OUTCOMES, required: true },
    reason: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now, immutable: true, index: true },
  },
  { collection: "audit_logs", versionKey: false }
);

auditEntrySchema.index({ actor: 1, timestamp: -1 });

// La bitacora es append-only: una vez escrita no se modifica ni se borra, si no dejaria de
// servir como evidencia auditable.
const BLOCKED_OPS = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
];
auditEntrySchema.pre(BLOCKED_OPS, function blockMutation() {
  throw new Error("audit_logs es append-only: no se permite modificar ni borrar entradas");
});
auditEntrySchema.pre("save", function blockResave() {
  if (!this.isNew) {
    throw new Error("audit_logs es append-only: no se permite modificar entradas existentes");
  }
});

const AuditEntry = mongoose.model("AuditEntry", auditEntrySchema);

module.exports = AuditEntry;
module.exports.OUTCOMES = OUTCOMES;
module.exports.ACTOR_TYPES = ACTOR_TYPES;
