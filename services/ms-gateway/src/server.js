const env = require("./config/env");
const logger = require("./tracing/logger");
const buildApp = require("./app");
const SecretsManager = require("./security/SecretsManager");
const createServer = require("./transport/createServer");

const secrets = new SecretsManager({ active: env.jwtSecret, previous: env.jwtSecretPrevious });
logger.info("jwt.llavero", secrets.status()); // solo ids de llave, nunca el secreto

const app = buildApp({ secrets, upstreams: env.upstreams, issuer: env.jwtIssuer, timeoutMs: env.upstreamTimeoutMs });
const server = createServer(app, env.tls);
server.listen(env.port, () => {
  const transport = env.tls.certPath ? (env.tls.caPath ? "mTLS" : "TLS") : "http";
  logger.info("ms-gateway escuchando", { port: env.port, transport });
});
