/**
 * ADR-06 / RNF-06: autenticacion ESCALONADA. Va DESPUES de requireAuth en las operaciones sensibles (autorizar el
 * envio de documentos a un tercero, cambiar de operador): ademas de una sesion valida, exige que el ciudadano haya
 * confirmado su contrasena hace poco (`POST /api/v1/auth/reauthenticate` en ms-identidad, que emite un access token
 * con el claim `reauth`). Copia propia de este servicio a proposito: ningun microservicio importa codigo de otro.
 *
 * Responde 401 con `error="insufficient_user_authentication"` y `max_age` en WWW-Authenticate (RFC 9470), para que el
 * cliente sepa que no es la sesion la que fallo sino que debe pedir la contrasena y reintentar.
 */
const CLOCK_SKEW_SECONDS = 60;

function requireRecentAuth({ maxAgeSeconds = 300, now = () => Date.now() } = {}) {
  return function stepUp(req, res, next) {
    const at = req.auth && req.auth.reauthAt;
    const nowSec = Math.floor(now() / 1000);
    if (Number.isSafeInteger(at) && at <= nowSec + CLOCK_SKEW_SECONDS && nowSec - at <= maxAgeSeconds) return next();
    res.set(
      "WWW-Authenticate",
      `Bearer realm="carpeta-ciudadana", error="insufficient_user_authentication", error_description="confirma tu contrasena", max_age=${maxAgeSeconds}`
    );
    return res.status(401).json({ error: "esta operacion requiere confirmar tu contrasena", reautenticacion: "POST /api/v1/auth/reauthenticate" });
  };
}

module.exports = requireRecentAuth;
