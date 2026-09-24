/**
 * Tabla de enrutamiento del gateway. Es una lista BLANCA: lo que no esta aqui responde 404 y nunca se
 * reenvia. Por defecto una ruta exige access token de CIUDADANO; solo las marcadas `public: true` pasan sin el
 * (las que sirven para OBTENER un token o registrarse).
 *
 * `actor: "entidad"` marca las rutas que exigen un token INSTITUCIONAL (ADR-07): otro emisor, otra llave y
 * `act: entidad`. Una ruta de entidad NUNCA se abre con un token de ciudadano, ni al reves.
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
  // ms-comparticion -- HU-06.1: registro de una entidad institucional. Publica (la entidad aun no tiene cuenta con nosotros);
  // el servicio puede exigir un token de registro (x-registration-token), que el gateway reenvia intacto.
  { method: "POST", path: "/api/v1/institutions", upstream: "COMPARTICION_URL", public: true },
  // ms-comparticion -- ADR-07: la entidad canjea sus credenciales por un token institucional. Publica por la misma
  // razon que el login del ciudadano: no se puede exigir un token para pedir un token.
  { method: "POST", path: "/api/v1/institutions/auth/token", upstream: "COMPARTICION_URL", public: true },
  // ms-documentos -- HU-03: carga de un documento a la carpeta del ciudadano (el servicio verifica que :id sea el del token)
  { method: "POST", pattern: /^\/api\/v1\/citizens\/[A-Za-z0-9_-]{1,64}\/documents$/, upstream: "DOCUMENTOS_URL" },
  // ms-documentos -- HU-08: consulta paginada (?page=&pageSize=) de los documentos de la carpeta; mismo control de dueno en el servicio
  { method: "GET", pattern: /^\/api\/v1\/citizens\/[A-Za-z0-9_-]{1,64}\/documents$/, upstream: "DOCUMENTOS_URL" },
  // ms-documentos -- HU-10 (RF-11): una entidad emisora entrega un documento en la carpeta de un ciudadano. Exige
  // token INSTITUCIONAL (ADR-07), no de ciudadano; el servicio ademas comprueba que la entidad este verificada.
  // No lleva el ciudadano en la ruta: va por su direccion unica, dentro del cuerpo.
  { method: "POST", path: "/api/v1/documents/inbound", upstream: "DOCUMENTOS_URL", actor: "entidad" },
];

function findRoute(method, path, routes = ROUTES) {
  return routes.find((r) => {
    if (r.method !== method) return false;
    if (r.pattern) return r.pattern.test(path);
    return r.prefix ? path === r.path || path.startsWith(`${r.path}/`) : path === r.path;
  });
}

module.exports = { ROUTES, findRoute };
