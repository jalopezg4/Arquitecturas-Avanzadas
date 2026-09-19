const fs = require("fs");
const http = require("http");
const https = require("https");

/**
 * Crea el servidor HTTP o HTTPS segun la configuracion TLS (HT-07).
 * - Sin certificado: HTTP plano. Es lo normal detras de un proxy/plataforma que termina TLS
 *   (Render, Railway) o en desarrollo local.
 * - Con certificado y llave: HTTPS con TLS 1.3 minimo (ADR-06 / tabla 7.1 del expediente).
 * - Ademas con CA: mTLS, se exige certificado de cliente firmado por esa CA (trafico entre servicios).
 */
function createServer(app, tls = {}) {
  const { certPath, keyPath, caPath } = tls;
  if (!certPath && !keyPath) return http.createServer(app);
  if (!certPath || !keyPath) throw new Error("TLS: certPath y keyPath deben definirse juntos");

  const options = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    minVersion: "TLSv1.3",
  };
  if (caPath) {
    options.ca = fs.readFileSync(caPath);
    options.requestCert = true;
    options.rejectUnauthorized = true;
  }
  return https.createServer(options, app);
}

module.exports = createServer;
