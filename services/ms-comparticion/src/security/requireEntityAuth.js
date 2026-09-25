/**
 * Middleware que EXIGE un access token INSTITUCIONAL valido (ADR-07).
 *
 * Es el gemelo de `requireAuth` (tokens de ciudadano, HU-02) pero NUNCA su sustituto: son dos mecanismos
 * separados a proposito, con llaves distintas y emisores distintos, y ninguno acepta el token del otro:
 *   - un token de ciudadano lo firma ms-identidad con JWT_SECRET      -> `iss: ms-identidad`, sin `act`
 *   - un token de entidad lo firma ms-comparticion con ENTITY_JWT_SECRET -> `iss: ms-comparticion`, `act: entidad`
 * Un token de ciudadano falla aqui DOS veces: su `kid` no esta en este llavero (otra llave) y su `iss`/`act`
 * no coinciden. Lo mismo, al reves, en `requireAuth`.
 *
 * Deja `req.auth = { institutionId, ... }` y NUNCA `ciudadanoId`: quien autoriza por dueno de carpeta
 * (`requireOwner` en ms-documentos) compara contra `ciudadanoId`, asi que un token institucional no puede
 * pasar por ciudadano ni siquiera por accidente (el campo simplemente no existe).
 *
 * Toda falla responde igual: 401 generico, sin decir cual de las comprobaciones fallo.
 */

const ENTITY_ISSUER = "ms-comparticion";
const ENTITY_ACTOR = "entidad";

function requireEntityAuth(entitySecrets, { issuer = ENTITY_ISSUER } = {}) {
  return function authenticateEntity(req, res, next) {
    // Sin llavero institucional configurado no se puede verificar nada: se falla cerrado, no se deja pasar.
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
      // Estado de verificacion de la entidad al momento de emitir el token (token de 15 min, dato reciente).
      // La autenticacion NO lo exige (ADR-07); es lo que HU-10 y HU-06.3 podran mirar para decidir si una
      // entidad autodeclarada puede o no entregar/solicitar documentos. Ver docs/SEGURIDAD.md, seccion 12.
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
