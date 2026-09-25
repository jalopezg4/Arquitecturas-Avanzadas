# HT-03 — Prueba de carga y escalamiento horizontal manual

> Prueba de carga sobre `ms-documentos` (servicio crítico) verificando cómo se comporta la latencia al
> escalar manualmente 1 → 2 → 3 réplicas (`docs/HISTORIAS_DE_USUARIO.md`, RNF-02).

**Las 5 corridas oficiales (A–E) ya están completas.** Resultado consolidado, metodología, diagnóstico y
conclusiones: [`results/HT03-RESULTADOS.md`](results/HT03-RESULTADOS.md). Este README documenta cómo
reproducir el procedimiento, no repite los resultados.

## Propósito

Demostrar empíricamente que `ms-documentos`:
1. puede correr con varias réplicas simultáneas (ya validado en el PASO 2: 3 réplicas, `docker compose up --scale ms-documentos=3`, sin conflicto de puerto);
2. recibe tráfico repartido entre esas réplicas a través del gateway (ya validado en el PASO 2: 40/40 peticiones con `200`, repartidas 15/13/12 entre las 3, identificadas por `trace-id` cruzado contra `docker logs`);
3. mantiene (o degrada) throughput/latencia de forma medible al variar el número de réplicas y la carga — esta parte es la que corre esta herramienta, con [k6](https://k6.io/).

**No pertenece a un solo microservicio** (mide `ms-documentos` a través de `ms-gateway`), por eso vive en `scripts/load-test/`, igual de independiente que `scripts/backup-restore/`.

## Qué NO hace esta prueba

- **No implementa autoescalamiento dinámico por CPU.** Docker Compose no lo provee bajo ninguna configuración (a diferencia de Kubernetes/HPA o ECS Service Auto Scaling); el escalamiento aquí es **manual**, vía `docker compose up --scale ms-documentos=N`. Esto queda documentado como limitación explícita de HT-03, no como algo pendiente de arreglar.
- **No siembra ni simula 1 millón de carpetas lógicas.** El dataset es pequeño y determinista (12 documentos para un único ciudadano sintético) — la prueba mide escalamiento de **tráfico/réplicas**, no de **volumen de datos**. Ver "Relación con RNF-02" en [`results/HT03-RESULTADOS.md`](results/HT03-RESULTADOS.md).
- **No modifica ni crea documentos**: el endpoint probado es de solo lectura (`GET`).

## Prerrequisitos

- El stack de `docker-compose.yml` levantado (`docker compose up -d`), con `ms-documentos` escalado según el escenario a probar.
- **Docker**, para correr k6 vía su imagen oficial (`grafana/k6`) — **no se instala k6 como dependencia npm de ningún servicio**.
- **Node.js 20+** dentro de esta carpeta, solo para `mint-test-token.js` y `seed-test-data.js` (tiene su propio `package.json`, como `scripts/backup-restore/`):
  ```bash
  cd scripts/load-test
  npm install
  ```

## 1. Generar el token de prueba

```bash
node mint-test-token.js
```

Imprime por stdout un JWT de acceso de **ciudadano sintético** (`sub: "ht03-loadtest-0001"`), firmado con el mismo secreto de desarrollo que ya usan `ms-identidad`/`ms-documentos`/`ms-gateway` en local (`INSECURE_DEV_JWT_SECRET`, ya presente en el repo — **no es una credencial real ni se introduce ningún secreto nuevo**). Replica exactamente lo que hace `SecretsManager.sign()`, incluido el header `kid` que `SecretsManager.verify()` exige. El secreto nunca se imprime ni se guarda en archivo, solo el token.

Guardarlo en una variable para los pasos siguientes:
```bash
export JWT_TOKEN=$(node mint-test-token.js)
```

## 2. Sembrar el dataset de prueba

```bash
node seed-test-data.js
# o, si Mongo no esta en localhost:27017:
MONGO_URI="mongodb://localhost:27017/ms-documentos" node seed-test-data.js
```

Crea (si no existen) una carpeta y 12 documentos para `ht03-loadtest-0001`, reutilizando **directamente los modelos Mongoose reales de `ms-documentos`** (`Document`, `Folder` — sin duplicar el schema) conectados a la misma base que usa el servicio. **Idempotente**: correrlo varias veces no duplica nada (upsert por `storageKey` determinístico). 12 documentos da 2 páginas a `pageSize=10` (10 + 2), un resultado no trivial pero pequeño y estable entre corridas.

## 3. Ejecutar k6

### Método recomendado (validado): red interna de Docker

**Para cualquier corrida con carga sostenida (≥50 req/s, ≥60s) usar SIEMPRE este método.** Se diagnosticó
(tres experimentos independientes, ver `results/diagnostic/`) que publicar el gateway al host
(`host.docker.internal:3000`) introduce una tasa de error real (`dial: i/o timeout`, 5-10%) bajo carga
sostenida, que **no** existe en la aplicación: el gateway y `ms-documentos` nunca reciben esas peticiones
(`gateway.upstream_error: 0`, `request.start` coincide exacto con las exitosas, nunca con el total generado).
El problema está acotado a la capa de publicación de puertos de Docker Desktop hacia Windows bajo carga
sostenida, no al código de la aplicación. Corriendo k6 **dentro** de la misma red Docker del proyecto,
resolviendo el gateway por su nombre de servicio, el fenómeno desaparece por completo (0 errores en 3000
requests a 50 req/s × 60s, con la mejor latencia observada en todo el diagnóstico: p99 8.99ms).

```bash
docker run --rm \
  --network arquitecturas-avanzadas_default \
  -e TARGET_RPS=10 -e TEST_DURATION=15s \
  -e BASE_URL=http://ms-gateway:3000 \
  -e CITIZEN_ID=ht03-loadtest-0001 -e JWT_TOKEN="$JWT_TOKEN" \
  -v "$(pwd -W)/scripts/load-test:/scripts" \
  grafana/k6 run --summary-export=/scripts/pilot-summary.json /scripts/load-test.js
```

`arquitecturas-avanzadas_default` es la red que crea `docker compose` para todo el stack (verificar con
`docker network ls` si el nombre del proyecto cambiara); `ms-gateway` es el alias DNS que Compose le asigna
al servicio en esa red (verificado con `docker inspect <contenedor-gateway> --format '{{json
.NetworkSettings.Networks}}'`) — **no se asume**, se inspecciona. No hace falta `--add-host` ni
`host.docker.internal` con este método: k6 nunca sale de la red interna de Docker.

**Invocación exacta usada en las 5 corridas oficiales A–E** (mismo mecanismo, solo cambian
`TARGET_RPS`/`<nombre>` — ver la matriz completa en `results/HT03-RESULTADOS.md`):

```bash
HT03_INSTANCE_ID=auto docker compose -f docker-compose.yml -f scripts/load-test/docker-compose.ht03.yml \
  up -d --scale ms-documentos=<1|2|3>

docker run --rm \
  --network arquitecturas-avanzadas_default \
  -e TARGET_RPS=<50|100> -e TEST_DURATION=60s \
  -e BASE_URL=http://ms-gateway:3000 \
  -e CITIZEN_ID=ht03-loadtest-0001 -e JWT_TOKEN="$JWT_TOKEN" \
  -v "$(pwd -W)/scripts/load-test:/scripts" \
  grafana/k6 run \
    --summary-export=/scripts/results/ht03-<carga>rps-<N>replica(s)-v2.json \
    --out json=/scripts/results/ht03-<carga>rps-<N>replica(s)-v2-raw.ndjson \
    /scripts/load-test.js
```

Antes de la corrida medida se ejecuta un calentamiento idéntico (10 req/s × 15s, mismo `--network`,
descartado). El sufijo `-v2` distingue estos resultados de la primera ronda (descartada, ver "Anexo" en
`results/HT03-RESULTADOS.md`).

### Método alternativo (con la limitación diagnosticada): puerto publicado del host

Solo para pruebas puntuales cortas y de baja carga (como la prueba piloto original, 10 req/s × 15s, donde
nunca se manifestó el problema):

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -e TARGET_RPS=10 -e TEST_DURATION=15s \
  -e BASE_URL=http://host.docker.internal:3000 \
  -e CITIZEN_ID=ht03-loadtest-0001 -e JWT_TOKEN="$JWT_TOKEN" \
  -v "$(pwd -W)/scripts/load-test:/scripts" \
  --add-host=host.docker.internal:host-gateway \
  grafana/k6 run --summary-export=/scripts/pilot-summary.json /scripts/load-test.js
```

### Windows / Git Bash

Problemas reales, no teóricos, encontrados al validar esto (mismo tipo de bug que en HT-02 con `tar`):

1. **`-v` con rutas mezcla host:contenedor separadas por `:`.** Git Bash reescribe argumentos que empiezan por `/` antes de pasarlos a `docker.exe` (binario nativo de Windows), lo que puede corromper el lado del contenedor (`/scripts`). Solución verificada: usar `$(pwd -W)` (ruta nativa de Windows que da Git Bash) para el lado del HOST, y anteponer `MSYS_NO_PATHCONV=1` para que Git Bash no reescriba nada más.
2. **Solo en el método alternativo**: `localhost:3000` desde dentro del contenedor de k6 no es el host de Windows. Hay que usar `host.docker.internal` (con `--add-host=host.docker.internal:host-gateway`) y `BASE_URL=http://host.docker.internal:3000`. **El método recomendado (`--network`) no tiene este problema en absoluto**, porque nunca sale del host Docker.

En Linux/CI `MSYS_NO_PATHCONV` no existe ni hace falta.

## Variables de entorno de `load-test.js`

| Variable | Obligatoria | Por defecto | Significado |
|---|---|---|---|
| `TARGET_RPS` | No | `10` | requests/segundo sostenidos (`constant-arrival-rate`) |
| `TEST_DURATION` | No | `"15s"` | duración de la ventana medida |
| `BASE_URL` | No | `http://localhost:3000` | URL del gateway |
| `CITIZEN_ID` | No | `ht03-loadtest-0001` | debe coincidir con el `sub` del JWT |
| `JWT_TOKEN` | **Sí** | — | sin valor por defecto a propósito: no existe un token "razonable" por defecto |

Los defaults de `TARGET_RPS`/`TEST_DURATION` son los de la **prueba piloto**, no los de las corridas oficiales de comparación (esas se invocan pasando estas mismas variables explícitas, sin tocar el script).

## Significado de las métricas (salida de k6)

| Métrica k6 | Qué mide |
|---|---|
| `http_reqs` | total de requests y tasa (requests/seg real lograda) |
| `http_req_failed` | tasa de error (cualquier respuesta que `check()` no marcó como esperada) |
| `http_req_duration` (`avg`, `p(95)`, `p(99)`) | latencia de la petición completa |
| `ht03_respuestas_por_instancia{instance=...}` | conteo de respuestas por valor de `X-Instance-Id` — solo tiene datos si `HT03_INSTANCE_ID` está activa (ver "Identificación de réplica" abajo) |
| `ht03_respuestas_sin_instance_id` | respuestas sin ese header — esperado si `HT03_INSTANCE_ID` no está activa |
| `ht03_respuestas_formato_invalido` | un `200` cuyo cuerpo no tenía la forma `{documentos:[], total:n, ...}` esperada — debería quedar en 0 |

## Piloto vs. corridas oficiales

- **Piloto** (validación del arnés, ya completada): 3 réplicas, `TARGET_RPS=10`, `TEST_DURATION=15s` (~150 requests) — objetivo: validar que el arnés completo funciona (token, seed, endpoint, k6, export de resumen), no medir rendimiento comparativo.
- **Corridas oficiales A–E** (ya completadas, ver [`results/HT03-RESULTADOS.md`](results/HT03-RESULTADOS.md)): matriz de 1/2/3 réplicas × carga base (50 req/s) / carga 2x (100 req/s), 60s cada una, con calentamiento previo descartado. Ejecutadas con el método recomendado de esta sección (`--network` + `ms-gateway:3000`) — 0 errores en las 5.

## Identificación de réplica con `X-Instance-Id` — cómo activarla

`ms-documentos` solo agrega el header `X-Instance-Id` si la variable de entorno `HT03_INSTANCE_ID` está
definida (middleware del PASO 1, deliberadamente apagado por defecto para no alterar el comportamiento
normal del servicio). Con el valor especial `auto`, cada réplica usa `os.hostname()` (el container ID que
Docker ya le asigna) — **el mismo valor `auto` para todas las réplicas es suficiente**: no hace falta un
valor distinto por réplica en la configuración, porque cada contenedor calcula el suyo en tiempo de
ejecución.

Activarla sin tocar `docker-compose.yml` (overlay dedicado, ya incluido en esta carpeta):

```bash
HT03_INSTANCE_ID=auto docker compose -f docker-compose.yml -f scripts/load-test/docker-compose.ht03.yml \
  up -d --scale ms-documentos=<N>
```

Validado en las 5 corridas oficiales: `X-Instance-Id` coincidió exacto con el hostname real de cada
contenedor en todos los casos (ver `results/HT03-RESULTADOS.md`, sección "Distribución real por réplica").
Antes de tener esto activo (PASO 2), la distribución entre réplicas se demostró de forma independiente
correlacionando el `x-trace-id` de cada respuesta contra `docker logs` de cada contenedor — ambos métodos
son válidos; `X-Instance-Id` es el que usan las corridas oficiales por ser más directo de capturar en k6.

## Autenticación — por qué es segura

`mint-test-token.js` no inventa un mecanismo nuevo: usa la misma clase `SecretsManager` (HS256 + `kid`) que ya firma/verifica tokens reales en `ms-identidad`/`ms-documentos`/`ms-gateway`, con el mismo secreto de **desarrollo local** que esos tres servicios ya comparten en el repo (nunca válido fuera de `NODE_ENV=development/test`, y el propio `ConfigValidator` de cada servicio exige uno fuerte y distinto en despliegue real). El `sub` (`ht03-loadtest-0001`) es un identificador sintético que nunca pasó por registro real ni por GovCarpeta.
