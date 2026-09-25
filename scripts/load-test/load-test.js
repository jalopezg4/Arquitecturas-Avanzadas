// HT-03 -- prueba de carga sobre GET /api/v1/citizens/:id/documents (HU-08), via el gateway.
// Corre con k6 (imagen oficial grafana/k6), NUNCA como dependencia npm de ningun microservicio -- ver README.
//
// Variables de entorno:
//   TARGET_RPS    requests/segundo sostenidos (constant-arrival-rate). Por defecto: 10
//   TEST_DURATION duracion de la ventana medida, p. ej. "15s", "60s". Por defecto: "15s"
//   BASE_URL      URL del gateway. Por defecto: "http://localhost:3000"
//   CITIZEN_ID    debe coincidir con el `sub` del JWT (requireOwner lo exige). Por defecto: "ht03-loadtest-0001"
//   JWT_TOKEN     token de acceso de ciudadano -- OBLIGATORIO, sin valor por defecto (no hay un token "razonable"
//                 por defecto: generarlo con `node mint-test-token.js`, ver README)
//
// Los valores por defecto de TARGET_RPS/TEST_DURATION son los de la PRUEBA PILOTO (pequena, para validar el
// arnes), no los de las corridas oficiales de comparacion 1/2/3 replicas -- esas se invocan con estas mismas
// variables puestas explicitamente a otros valores, sin tocar este archivo.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const TARGET_RPS = Number(__ENV.TARGET_RPS || 10);
const TEST_DURATION = __ENV.TEST_DURATION || "15s";
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const CITIZEN_ID = __ENV.CITIZEN_ID || "ht03-loadtest-0001";
const JWT_TOKEN = __ENV.JWT_TOKEN || "";

// Holgura sobre la tasa objetivo para que constant-arrival-rate nunca se quede sin VUs disponibles
// (si faltan VUs, k6 reporta "dropped iterations" y la tasa real cae por debajo de TARGET_RPS).
const PRE_ALLOCATED_VUS = Math.max(5, Math.ceil(TARGET_RPS * 2));
const MAX_VUS = Math.max(10, Math.ceil(TARGET_RPS * 4));

export const options = {
  // Por defecto k6 no incluye p(99) en el resumen (solo avg/min/med/max/p90/p95) -- se pide explicito
  // porque HT-03 lo exige como metrica de comparacion.
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  scenarios: {
    ht03_lectura_documentos: {
      executor: "constant-arrival-rate",
      rate: TARGET_RPS,
      timeUnit: "1s",
      duration: TEST_DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
};

// Cuenta cuantas respuestas trajo cada valor de X-Instance-Id (si el header no viene, no se inventa nada:
// se cuenta aparte en `ht03_respuestas_sin_instance_id`). Ver README: en el piloto, sin HT03_INSTANCE_ID
// configurada por replica en docker-compose.yml, se espera que ESTE contador quede en 0 y todo caiga en
// "sin_instance_id" -- la distribucion real ya se valido en el PASO 2 via trace-id + docker logs.
const respuestasPorInstancia = new Counter("ht03_respuestas_por_instancia");
const respuestasSinInstanceId = new Counter("ht03_respuestas_sin_instance_id");
const respuestasFormatoInvalido = new Counter("ht03_respuestas_formato_invalido");

function getHeaderCaseInsensitive(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

export function setup() {
  if (!JWT_TOKEN) {
    throw new Error("HT-03: falta JWT_TOKEN. Generar uno con: node mint-test-token.js (ver README de scripts/load-test)");
  }
}

export default function () {
  const url = `${BASE_URL}/api/v1/citizens/${CITIZEN_ID}/documents?page=1&pageSize=10`;
  const res = http.get(url, {
    headers: { Authorization: `Bearer ${JWT_TOKEN}` },
    tags: { name: "listar_documentos_ciudadano" },
  });

  const esperado200 = check(res, { "status es 200": (r) => r.status === 200 });

  let formatoOk = false;
  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      formatoOk = Array.isArray(body.documentos) && typeof body.total === "number";
    } catch {
      formatoOk = false;
    }
  }
  check(res, { "cuerpo con forma esperada": () => formatoOk });
  if (res.status === 200 && !formatoOk) respuestasFormatoInvalido.add(1);

  const instanceId = getHeaderCaseInsensitive(res.headers, "X-Instance-Id");
  if (instanceId) respuestasPorInstancia.add(1, { instance: instanceId });
  else respuestasSinInstanceId.add(1);

  if (!esperado200) {
    console.error(`HT-03: respuesta inesperada -- status=${res.status} body=${(res.body || "").slice(0, 200)}`);
  }
}
