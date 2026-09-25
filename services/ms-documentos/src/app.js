const os = require("os");
const express = require("express");
const tracingMiddleware = require("./tracing/tracingMiddleware");
const documentRoutes = require("./interfaces/documentRoutes");
const { makeDocumentController, errorHandler } = require("./interfaces/documentController");

/**
 * Ensambla la app inyectando dependencias -- facil de probar con supertest.
 *
 * `inboundDocumentService` y `entitySecrets` son de HU-10 (recepcion desde una entidad emisora). Sin ellos el
 * servicio sigue atendiendo al ciudadano igual: la ruta institucional responde 401 (el middleware falla cerrado).
 */
function buildApp({ documentService, inboundDocumentService, secrets, entitySecrets, issuer, entityIssuer, auditLogger, maxUploadBytes, maxInboundBytes }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(tracingMiddleware);

  // HT-03: identificador de instancia SOLO si se define explicitamente (variable de entorno propia de la
  // prueba de carga, nunca activa en la operacion normal del servicio). Permite distinguir que replica
  // respondio cada peticion cuando el servicio esta escalado a varios contenedores. "auto" usa el hostname
  // del contenedor (Docker le asigna uno distinto a cada replica, sin necesitar un valor distinto por
  // replica en la configuracion); cualquier otro valor se usa tal cual, para pruebas manuales fuera de Docker.
  const ht03InstanceIdRaw = process.env.HT03_INSTANCE_ID;
  const ht03InstanceId = ht03InstanceIdRaw === "auto" ? os.hostname() : ht03InstanceIdRaw;
  if (ht03InstanceId) {
    app.use((_req, res, next) => {
      res.setHeader("X-Instance-Id", ht03InstanceId);
      next();
    });
  }

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => res.status(200).json({ status: "ready" }));

  // Sin express.json(): la unica ruta recibe multipart (multer) y nada aqui debe parsear cuerpos sin limite.
  app.use(
    "/api/v1",
    documentRoutes({
      controller: makeDocumentController(documentService, inboundDocumentService),
      secrets,
      entitySecrets,
      issuer,
      entityIssuer,
      auditLogger,
      maxUploadBytes,
      maxInboundBytes: maxInboundBytes || maxUploadBytes,
    })
  );

  app.use(errorHandler);
  return app;
}

module.exports = buildApp;
