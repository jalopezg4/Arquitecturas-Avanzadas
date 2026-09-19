/**
 * Tabla de enrutamiento del gateway. Es una lista BLANCA: lo que no esta aqui responde 404 y nunca se
 * reenvia. Por defecto una ruta exige access token; solo las marcadas `public: true` pasan sin el
 * (las que sirven para OBTENER un token o registrarse).
 *
 * Para un servicio nuevo: agregar su URL en config/env.js (`upstreams`) y sus rutas aqui.
 * `prefix: true` hace que la ruta cubra tambien todo lo que cuelgue de ella; `pattern` (RegExp) para rutas con
 * parametros (p. ej. /citizens/:id/documents). El patron debe ser ESTRICTO: nada de comodines amplios.
 */
const ROUTES = [
  // ms-identidad -- publicas: no se puede exigir token para pedirlo ni para registrarse
  { method: "POST", path: "/api/v1/citizens", upstream: "IDENTIDAD_URL", public: true },
  { method: "POST", path: "/api/v1/auth/login", upstream: "IDENTIDAD_URL", public: true },
  { method: "POST", path: "/api/v1/auth/refresh", upstream: "IDENTIDAD_URL", public: true },
  // ms-identidad -- protegidas
  { method: "GET", path: "/api/v1/auth/me", upstream: "IDENTIDAD_URL" },
  // ms-documentos -- HU-03: carga de un documento a la carpeta del ciudadano (el servicio verifica que :id sea el del token)
  { method: "POST", pattern: /^\/api\/v1\/citizens\/[A-Za-z0-9_-]{1,64}\/documents$/, upstream: "DOCUMENTOS_URL" },
];

function findRoute(method, path, routes = ROUTES) {
  return routes.find((r) => {
    if (r.method !== method) return false;
    if (r.pattern) return r.pattern.test(path);
    return r.prefix ? path === r.path || path.startsWith(`${r.path}/`) : path === r.path;
  });
}

module.exports = { ROUTES, findRoute };
