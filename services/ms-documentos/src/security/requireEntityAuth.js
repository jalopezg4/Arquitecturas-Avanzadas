/**
 * Exige un access token INSTITUCIONAL valido (ADR-07). Preparado para HU-10 (recepcion de un documento enviado
 * por una entidad emisora): TODAVIA NO hay ninguna ruta montada con el; la carga y la consulta del ciudadano
 * siguen exactamente igual, protegidas por `requireAuth` + `requireOwner`.
 *
 * Los dos mecanismos son independientes y ninguno acepta el token del otro:
 *   ciudadano -> firma ms-identidad con JWT_SECRET           -> iss: ms-identidad,    sin `act`
 *   entidad   -> firma ms-comparticion con ENTITY_JWT_SECRET -> iss: ms-comparticion, act: entidad
 *
 * Deja `req.auth.institutionId` y NUNCA `ciudadanoId`, que es lo que `requireOwner` compara: asi un token
 * institucional no puede pasar por dueno de una carpeta ni por accidente. Cuando HU-10 monte su ruta, el actor
 * sera la entidad y el dueno del recurso el ciudadano, y la entrada de bitacora debera ir con `delegated: true`
 * (ver docs/SEGURIDAD.md, seccion 12) para no contarse como violacion de RNF-07.
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
