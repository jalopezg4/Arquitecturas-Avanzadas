/**
 * Exige un access token valido (HU-02, ADR-06). Es el mismo criterio que aplica ms-identidad y que debe
 * aplicar cada microservicio por su cuenta: el gateway es la primera barrera, NO la unica.
 *
 * Verifica firma (llavero de HT-07, algoritmo fijado), expiracion, emisor y que sea un token de ACCESO
 * (un refresh token robado no sirve para llamar a la API). Toda falla responde igual: 401 generico.
 */
function requireAuth(secrets, { issuer = "ms-identidad" } = {}) {
  return function authenticate(req, res, next) {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
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
