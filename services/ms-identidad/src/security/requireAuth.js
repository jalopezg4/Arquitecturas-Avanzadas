/**
 * Middleware que EXIGE un access token valido (HU-02, ADR-06).
 *
 * Cada microservicio lo monta por su cuenta: la autorizacion no se delega solo al gateway. Verifica
 * firma (con el llavero de HT-07, algoritmo fijado), expiracion, emisor y que sea un token de ACCESO
 * (un refresh token robado no sirve para llamar a la API). Toda falla responde igual: 401 generico.
 */
const { ISSUER } = require("../application/AuthService");

function requireAuth(secrets, { issuer = ISSUER } = {}) {
  return function authenticate(req, res, next) {
    const header = req.headers.authorization || "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return reject(res);

    let payload;
    try {
      payload = secrets.verify(match[1]);
    } catch {
      return reject(res);
    }
    if (payload.typ !== "access" || payload.iss !== issuer || !payload.sub) return reject(res);

    req.auth = { ciudadanoId: payload.sub, tokenId: payload.jti };
    return next();
  };
}

function reject(res) {
  res.set("WWW-Authenticate", 'Bearer realm="carpeta-ciudadana"');
  return res.status(401).json({ error: "token invalido o expirado" });
}

module.exports = requireAuth;
