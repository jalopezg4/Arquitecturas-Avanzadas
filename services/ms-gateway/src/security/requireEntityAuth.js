/**
 * Exige un access token INSTITUCIONAL valido (ADR-07). Es el gemelo de `requireAuth` (tokens de ciudadano) y
 * NUNCA su sustituto: cada uno verifica con SU llavero y su emisor, y ninguno acepta el token del otro.
 *
 *   ciudadano -> firma ms-identidad con JWT_SECRET        -> iss: ms-identidad,    sin `act`
 *   entidad   -> firma ms-comparticion con ENTITY_JWT_SECRET -> iss: ms-comparticion, act: entidad
 *
 * El gateway es la primera barrera, no la unica: el servicio destino vuelve a validar (ADR-06). Deja
 * `req.auth.institutionId` y nunca `ciudadanoId`, para que nada aguas abajo confunda una entidad con un ciudadano.
 * Toda falla responde igual: 401 generico.
 */

const ENTITY_ISSUER = "ms-comparticion";
const ENTITY_ACTOR = "entidad";

function requireEntityAuth(entitySecrets, { issuer = ENTITY_ISSUER } = {}) {
  return function authenticateEntity(req, res, next) {
    // Sin ENTITY_JWT_SECRET configurado no hay con que verificar: se falla cerrado y no se contacta al destino.
    if (!entitySecrets) return reject(res);

    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    if (!match) return reject(res);

    let payload;
    try {
      payload = entitySecrets.verify(match[1]);
    } catch {
      return reject(res);
    }
    if (payload.typ !== "access" || payload.iss !== issuer || payload.act !== ENTITY_ACTOR || !payload.sub) return reject(res);

    req.auth = { institutionId: payload.sub, tokenId: payload.jti, actorType: ENTITY_ACTOR, verificada: payload.ver === true };
    return next();
  };
}

function reject(res) {
  res.set("WWW-Authenticate", 'Bearer realm="carpeta-ciudadana-entidades"');
  return res.status(401).json({ error: "token invalido o expirado" });
}

module.exports = requireEntityAuth;
module.exports.ENTITY_ISSUER = ENTITY_ISSUER;
module.exports.ENTITY_ACTOR = ENTITY_ACTOR;
