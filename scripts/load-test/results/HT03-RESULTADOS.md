# HT-03 — Resultados consolidados

**Estado: oficial y definitivo.** Este documento reemplaza el reporte de la primera ronda (conservado más
abajo, en "Anexo — Ronda 1", únicamente por transparencia del proceso). La primera ronda usó un mecanismo
de red defectuoso (`host.docker.internal`) que introducía errores ajenos a la aplicación; fue diagnosticado,
corregido y **toda la serie A–E se repitió con el mecanismo corregido**. Los resultados de esta segunda
ronda (sufijo `-v2` en los archivos) son los que cuentan como evidencia de HT-03.

## 1. Metodología

- **Objetivo:** demostrar que `ms-documentos` (servicio crítico, RNF-02) puede escalarse horizontalmente de
  forma manual (1 → 2 → 3 réplicas) y medir throughput/latencia/errores bajo carga sostenida, comparando
  además el efecto de duplicar la carga (50 → 100 req/s).
- **Herramienta:** [k6](https://k6.io/) vía su imagen oficial `grafana/k6`, corrido como contenedor
  desechable — nunca instalado como dependencia npm de ningún servicio (`scripts/load-test/load-test.js`).
- **Endpoint probado (único, sin cambios entre corridas):**
  `GET /api/v1/citizens/ht03-loadtest-0001/documents?page=1&pageSize=10`, de solo lectura, elegido porque
  no toca MinIO (solo Mongo, vía índice en `ciudadanoId`) y ejercita el camino real de autenticación
  (`requireAuth` + `requireOwner`), ver `scripts/load-test/README.md`.
- **Dataset:** sembrado **una sola vez** al inicio de toda la serie (`seed-test-data.js`, 1 carpeta + 12
  documentos deterministas para el ciudadano sintético `ht03-loadtest-0001`, reutilizando directamente los
  modelos Mongoose reales de `ms-documentos`). Verificado intacto (`creados=0, ya_existian=12`) antes y
  después de cada una de las 5 corridas oficiales — el endpoint es de solo lectura, así que nunca hubo
  riesgo de que una corrida contaminara la siguiente.
- **Autenticación:** JWT sintético (`mint-test-token.js`), firmado con el mismo secreto de desarrollo local
  que ya comparten `ms-identidad`/`ms-documentos`/`ms-gateway` en el repo — nunca una credencial real.
- **Identificación de réplica:** `HT03_INSTANCE_ID=auto` (middleware de `services/ms-documentos/src/app.js`,
  agregado en PASO 1 de esta HT, inactivo por defecto), activado vía el overlay
  `scripts/load-test/docker-compose.ht03.yml` combinado con `docker-compose.yml` — **sin tocar el compose
  principal**. Cada réplica calcula `os.hostname()` (el container ID que Docker ya asigna) y lo expone en el
  header `X-Instance-Id`.
- **Calentamiento:** 10 req/s × 15s antes de cada corrida medida, descartado (no se guarda como resultado
  oficial) — evita que el arranque en frío (JIT, pool de Mongo) contamine la medición.
- **Carga medida:** `constant-arrival-rate` de k6, 50 o 100 req/s sostenidos durante 60s exactos, sin cambiar
  el script entre corridas (solo las variables de entorno `TARGET_RPS`/`TEST_DURATION`/`BASE_URL`).
- **Escalamiento:** manual, vía `docker compose ... up -d --scale ms-documentos=N` antes de cada corrida —
  nunca automático.

## 2. Arquitectura de prueba

```
k6 (contenedor, --network arquitecturas-avanzadas_default)
  ↓  BASE_URL=http://ms-gateway:3000  (DNS interno de Docker, alias real del servicio)
ms-gateway  (Express + http-proxy-middleware, agente sin keepAlive hacia DOCUMENTOS_URL)
  ↓  red interna de Docker (round-robin del DNS embebido entre las réplicas escaladas)
ms-documentos × N réplicas  (Express + Mongoose, endpoint de solo lectura)
  ↓
MongoDB (instancia única, compartida, `ciudadanoId` indexado)
```

k6 corre **dentro** de la misma red Docker del proyecto (`arquitecturas-avanzadas_default`, verificada con
`docker network ls`/`docker inspect`, nunca asumida), resolviendo el gateway por su alias DNS `ms-gateway`.
No se publica ningún puerto adicional de `ms-documentos` al host; solo el `3000:3000` que el gateway ya
publica normalmente en `docker-compose.yml`.

## 3. Diagnóstico de `host.docker.internal`

La primera ronda (`k6 → host.docker.internal:3000 → gateway → ms-documentos`) mostró una tasa de error de
5.35%–10.12% en las 5 corridas, con el mensaje `dial: i/o timeout` — un fallo de conexión TCP, no una
respuesta de error de la aplicación. Se investigó con 3 experimentos independientes (`results/diagnostic/`,
documentado también en el hilo de la sesión):

1. **`k6 → :3002 → ms-documentos` (directo, sin gateway), 50 req/s × 60s:** 0 errores.
2. **`k6 → :3000 → gateway → ms-documentos`, misma carga:** reprodujo el fenómeno (230 errores), con
   `gateway.upstream_error: 0` y `request.start` del gateway coincidiendo exacto con las respuestas
   *exitosas*, nunca con el total generado — **las peticiones fallidas nunca llegaron al proceso del
   gateway ni de `ms-documentos`**.
3. **`k6 → red interna Docker → ms-gateway:3000 → ms-documentos` (sin ningún puerto publicado), misma
   carga:** 0 errores, mejor latencia de todo el diagnóstico (p99 8.99ms).

**Conclusión del diagnóstico:** el problema estaba acotado a la capa de publicación de puertos de Docker
Desktop hacia el host de Windows (`host.docker.internal`) bajo carga sostenida (aparecía siempre después de
~30-40s, nunca desde el inicio) — **no** al código de `ms-gateway`, **no** al código de `ms-documentos`, y
**no** a `keepAlive:false` (que solo afecta el segundo salto gateway→documentos, nunca el salto donde
ocurría el fallo). Corregido usando `--network arquitecturas-avanzadas_default` + `BASE_URL=http://ms-gateway:3000`
para toda la serie oficial.

## 4. Configuración final validada

```bash
docker run --rm \
  --network arquitecturas-avanzadas_default \
  -e TARGET_RPS=<50|100> -e TEST_DURATION=60s \
  -e BASE_URL=http://ms-gateway:3000 \
  -e CITIZEN_ID=ht03-loadtest-0001 -e JWT_TOKEN="$JWT_TOKEN" \
  -v "$(pwd -W)/scripts/load-test:/scripts" \
  grafana/k6 run --summary-export=/scripts/results/<nombre>.json --out json=/scripts/results/<nombre>-raw.ndjson /scripts/load-test.js
```

Sin `--add-host`, sin `host.docker.internal`, sin ningún puerto adicional publicado.

## 5. Resultado principal (A–E, ronda corregida)

| Prueba | Réplicas | Carga | Requests | Exitosas | Error % | Dropped iter. | Avg | P95 | P99 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A — línea base | 1 | 50 req/s | 3000 | 3000 | **0.00%** | 0 | 5.80ms | 7.05ms | 8.20ms | 9.33ms |
| B — 2 réplicas | 2 | 50 req/s | 3000 | 3000 | **0.00%** | 0 | 6.05ms | 7.43ms | 8.73ms | 12.73ms |
| C — 3 réplicas | 3 | 50 req/s | 3001 | 3001 | **0.00%** | 0 | 7.00ms | 9.39ms | 11.34ms | 29.82ms |
| D — 1 réplica, 2x | 1 | 100 req/s | 6000 | 6000 | **0.00%** | 0 | 5.77ms | 7.06ms | 8.56ms | 14.33ms |
| E — 3 réplicas, 2x | 3 | 100 req/s | 6001 | 6001 | **0.00%** | 0 | 6.17ms | 7.72ms | 9.28ms | 26.28ms |

**0 errores, 0 dropped iterations, 0 `dial`/`timeout`/`status=0`, 0 HTTP 4xx/5xx, en las 5 corridas.**
`checks_succeeded: 100.00%` en todas (`status es 200` + `cuerpo con forma esperada`). Cruce de contadores
verificado en cada corrida: **k6 exitosas = `gateway request.start` = suma de `request.start` de las
réplicas activas = 0 `gateway.upstream_error`**, sin excepción. Errores por bucket de 10s: **0 en los 30
buckets** (6 por corrida × 5 corridas).

## 6. Distribución real por réplica

| Prueba | Instancia (hostname) | Requests | % |
|---|---|---:|---:|
| A | `e575d6a65b39` | 3000 | 100% |
| B | `e575d6a65b39` | 1465 | 48.8% |
| B | `8f948a652553` | 1535 | 51.2% |
| C | `e575d6a65b39` | 995 | 33.2% |
| C | `8f948a652553` | 1021 | 34.0% |
| C | `601ee9c4825a` | 985 | 32.8% |
| D | `e575d6a65b39` | 6000 | 100% |
| E | `e575d6a65b39` | 2024 | 33.7% |
| E | `fd5864540534` | 1991 | 33.2% |
| E | `7718d2173ade` | 1986 | 33.1% |

En cada corrida, `X-Instance-Id` se verificó **coincidente exacto** con el hostname real del contenedor
(`docker exec ... os.hostname()`), medido antes de cada prueba. **No es perfectamente uniforme** (B:
48.8/51.2; C: 33.2/34.0/32.8; E: 33.7/33.2/33.1), pero en las 3 corridas con más de una réplica todas las
réplicas activas recibieron tráfico real y comparable — ninguna quedó en 0% ni concentró el tráfico.

## 7. CPU / memoria (máximo observado por contenedor)

| Prueba | Contenedor | CPU (máx.) | Memoria (máx.) |
|---|---|---:|---:|
| A | ms-documentos-1 | 25.27% | 57.43 MiB |
| A | ms-gateway | 15.63% | 39.74 MiB |
| B | ms-documentos-1 | 16.04% | 48.10 MiB |
| B | ms-documentos-2 | 15.44% | 73.24 MiB |
| B | ms-gateway | 17.12% | 29.66 MiB |
| C | ms-documentos-1 | 10.89% | 60.24 MiB |
| C | ms-documentos-2 | 12.58% | 55.30 MiB |
| C | ms-documentos-3 | 16.14% | 57.29 MiB |
| C | ms-gateway | 18.18% | 44.98 MiB |
| D | ms-documentos-1 | 35.57% | 73.50 MiB |
| D | ms-gateway | 28.72% | 53.37 MiB |
| E | ms-documentos-1 | 12.55% | 72.23 MiB |
| E | ms-documentos-2 | 20.81% | 46.14 MiB |
| E | ms-documentos-3 | 19.20% | 40.20 MiB |
| E | ms-gateway | 30.11% | 32.35 MiB |

Máximo absoluto de todo el experimento: **35.57%** (`ms-documentos`, prueba D). Ningún componente se acercó
a saturación en ninguna corrida, ni siquiera al duplicar la carga.

## 8. Conclusiones

- **Escalamiento horizontal manual: demostrado.** 1 → 2 → 3 réplicas de `ms-documentos`, sin ningún cambio
  de código ni rediseño — solo `docker compose --scale`.
- **Distribución de tráfico real entre réplicas: demostrada.** `X-Instance-Id` (activado vía
  `HT03_INSTANCE_ID=auto`) coincide exacto con el hostname real de cada contenedor en las 10 filas de la
  tabla de distribución; ninguna réplica activa quedó sin tráfico.
- **Comportamiento ante el doble de carga:** con el mecanismo de red corregido, duplicar la carga (50→100
  req/s) mantuvo el sistema en **0% de error** tanto con 1 réplica (D) como con 3 (E) — la latencia se
  mantuvo baja y estable (p99 ≤ 9.28ms en las 5 corridas), muy por debajo de cualquier indicio de
  degradación real del servicio.
- **`ms-documentos` nunca fue el cuello de botella** en ninguna corrida: CPU máxima 35.57%, sin errores de
  aplicación, sin un solo `gateway.upstream_error`.
- **El límite real encontrado durante HT-03 no estaba en la aplicación**: estaba en el mecanismo de prueba
  (publicación de puertos de Docker Desktop hacia Windows bajo carga sostenida). Diagnosticarlo con
  evidencia (no descartarlo por conjetura) y corregir el arnés de prueba, no el código, fue el resultado
  correcto — documentado en la sección 3 y en `results/diagnostic/`.

## 9. Limitaciones

- **El escalamiento es manual, no autoescalamiento.** Docker Compose no provee autoescalamiento dinámico
  por CPU bajo ninguna configuración (a diferencia de Kubernetes/HPA o ECS Service Auto Scaling). Todo el
  escalamiento de HT-03 se hizo explícitamente vía `--scale`, nunca de forma automática ni reactiva a carga.
- **No se validó la capacidad de 1 millón de carpetas lógicas (RNF-02).** El dataset usado fue
  deliberadamente pequeño y fijo (12 documentos, 1 ciudadano sintético) durante toda la serie. Esta prueba
  demuestra **escalamiento de tráfico/réplicas**, no **volumen de datos**. El índice en `ciudadanoId` hace
  razonable esperar que el patrón de consulta escale con el volumen, pero eso es una inferencia de diseño,
  no algo medido aquí — no se afirma ni se debe interpretar lo contrario.
- **El entorno es Docker Desktop en Windows, en una máquina de desarrollo compartida con los demás
  contenedores del proyecto** (Mongo, RabbitMQ, MinIO, los otros microservicios) y con el propio generador
  de carga. Los números son válidos de forma relativa entre las corridas de esta misma serie; no son
  comparables con un entorno de producción real.
- **El endpoint probado es de solo lectura** y no toca MinIO — no se midió el camino de carga de
  documentos (`POST`), que sí involucra el object storage y probablemente tenga un perfil de
  rendimiento distinto.
- **La huella de verificación de `ms-documentos` no se ejercitó aquí** (HT-02, no HT-03) — esta serie mide
  tráfico HTTP, no backup/restore.

## 10. Artefactos generados

Por cada corrida oficial (`ht03-<carga>-<réplicas>-v2`), en `scripts/load-test/results/`:
- `<nombre>.json` — resumen k6 (`--summary-export`).
- `<nombre>-raw.ndjson` — todos los puntos individuales con tags (`--out json`), usado para calcular la
  distribución exacta por instancia y los buckets de 10s. Archivos grandes (12–24 MB cada uno).
- `<nombre>-docker-stats.log` — CPU/memoria muestreados cada 3s durante la ventana medida.
- `<nombre>-log.txt` — log completo de la corrida (escalado, verificación pre-corrida, calentamiento,
  resumen k6).
- `<nombre>-ms-gateway.log` / `<nombre>-ms-documentos*.log` — logs reales de cada contenedor durante la
  ventana exacta de la corrida (usados para el cruce de contadores de la sección 5).

El diagnóstico de `host.docker.internal` (sección 3) tiene sus propios artefactos en
`scripts/load-test/results/diagnostic/`.

---

## Anexo — Ronda 1 (descartada, conservada por transparencia)

La primera ejecución de A–E usó `k6 → host.docker.internal:3000 → gateway → ms-documentos` y mostró errores
de 5.35%–10.12% que el diagnóstico de la sección 3 atribuyó al mecanismo de prueba, no a la aplicación.
Esos resultados **no se usan como evidencia de HT-03** — se conservan íntegros en
`scripts/load-test/results/ht03-*rps-*replica*.json` (sin sufijo `-v2`) y su análisis original abajo, solo
para que quede constancia del proceso de investigación que llevó a la ronda corregida.

| Prueba | Réplicas | Carga | Requests | RPS real | Error % | Avg | P95 | P99 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 1 | 50 req/s | 2968 | 33.02/s | 5.35% | 7.08ms | 9.24ms | 12.07ms |
| B | 2 | 50 req/s | 2749 | 31.15/s | 8.43% | 6.97ms | 9.14ms | 11.69ms |
| C | 3 | 50 req/s | 2944 | 32.74/s | 7.16% | 7.07ms | 9.39ms | 11.24ms |
| D | 1 | 100 req/s | 5814 | 64.64/s | 7.89% | 14.55ms | 24.91ms | 69.96ms |
| E | 3 | 100 req/s | 5400 | 60.09/s | 10.12% | 16.76ms | 33.96ms | 77.40ms |

El error, en las 5 corridas, fueron timeouts de conexión (`dial: i/o timeout`) concentrados después de
~30-40s de carga sostenida, nunca errores HTTP ni errores de aplicación — patrón que llevó directamente al
diagnóstico de la sección 3.
