const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const SecretsManager = require("./security/SecretsManager");
const createServer = require("./transport/createServer");

const secrets = new SecretsManager({ active: env.jwtSecret, previous: env.jwtSecretPrevious });
logger.info("jwt.llavero", secrets.status()); // solo ids de llave, nunca el secreto

// ADR-07: llavero aparte para verificar los tokens institucionales que firma ms-comparticion. Si no hay llave
// configurada, el gateway arranca igual y las rutas de entidad responden 401 (fallan cerrado).
const entitySecrets = env.entityJwtSecret ? new SecretsManager({ active: env.entityJwtSecret, previous: env.entityJwtSecretPrevious }) : null;
if (entitySecrets) logger.info("jwt.llavero_entidades", entitySecrets.status());
else logger.warn("ENTITY_JWT_SECRET no esta configurado: las rutas que exigen token institucional (ADR-07) responderan 401.");

const app = buildApp({
  secrets,
  entitySecrets,
  upstreams: env.upstreams,
  issuer: env.jwtIssuer,
  entityIssuer: env.entityJwtIssuer,
  timeoutMs: env.upstreamTimeoutMs,
});
const server = createServer(app, env.tls);
server.listen(env.port, () => {
  const transport = env.tls.certPath ? (env.tls.caPath ? "mTLS" : "TLS") : "http";
  logger.info("ms-gateway escuchando", { port: env.port, transport });
});
