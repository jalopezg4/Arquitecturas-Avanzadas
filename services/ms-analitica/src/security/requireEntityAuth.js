/**
 * Exige un access token INSTITUCIONAL valido (ADR-07). Es el UNICO mecanismo de autenticacion de este servicio
 * (HU-07.2): ms-analitica no conoce JWT_SECRET ni verifica tokens de ciudadano, solo los institucionales que
 * firma ms-comparticion. `req.auth.institutionId` (el `sub` del token) es la unica fuente de la institucion
 * dueña de un caso PQRS: nunca se confia en un `institutionId` que llegue en el cuerpo o en la URL.
 *
 * Mismo mecanismo, sin duplicar codigo de verificacion, que ya usan ms-gateway, ms-documentos (HU-10) y el propio
 * ms-comparticion (que lo emite). Por ahora solo valida la IDENTIDAD institucional (`act: entidad`, firma y
 * expiracion) -- institucion autenticada != institucion Premium: la restriccion de plan Premium queda
 * deliberadamente sin implementar aqui, es una decision pendiente, no un olvido (docs/SEGURIDAD.md, seccion 12.2).
 *
 * Toda falla responde igual: 401 generico.
 */

const ENTITY_ISSUER = "ms-comparticion";
const ENTITY_ACTOR = "entidad";

function requireEntityAuth(entitySecrets, { issuer = ENTITY_ISSUER } = {}) {
  return function authenticateEntity(req, res, next) {
    // Sin ENTITY_JWT_SECRET configurado no hay con que verificar: se falla cerrado.
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

    req.auth = {
      institutionId: payload.sub,
      tokenId: payload.jti,
      actorType: ENTITY_ACTOR,
      // Estado de verificacion de la entidad al emitirse el token. HU-10 decidira si exige `verificada` para
      // aceptar una entrega: el registro de entidades es autodeclarado (docs/SEGURIDAD.md, seccion 10).
      verificada: payload.ver === true,
    };
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
