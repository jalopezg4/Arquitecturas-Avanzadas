# HT-02 — Respaldo y restauración verificada de almacenamiento

> Prueba periódica automatizada de restauración sobre MongoDB y el object storage — no basta con que el
> proveedor diga que hace backups, hay que probar la restauración (RNF-03, `docs/HISTORIAS_DE_USUARIO.md`).

Esta herramienta **no pertenece a un solo microservicio**: MongoDB es una sola instancia compartida por las
5 bases lógicas del proyecto, y MinIO es de `ms-documentos` pero el mecanismo de respaldo/restauración es
el mismo problema de infraestructura para los dos. Por eso vive en `scripts/backup-restore/`, en la raíz
del repositorio, igual de independiente que `docker-compose.yml`.

## Qué respalda

| Componente | Alcance |
|---|---|
| **MongoDB** | La instancia **completa** (`mongodump` sin `--db`): las 5 bases lógicas — `ms-identidad`, `ms-documentos`, `ms-notificaciones`, `ms-interoperabilidad`, `ms-comparticion` — en un solo `mongodump --archive --gzip`, coherente con que en este proyecto es una sola instancia física (un solo `mongo:` en `docker-compose.yml`, un solo volumen `mongo-data`) |
| **MinIO** | El bucket `carpeta-documentos` (o el que indique `S3_BUCKET`), objeto por objeto, vía `@aws-sdk/client-s3` — la misma librería que ya usa `services/ms-documentos` |

## Qué NO respalda

- **PostgreSQL** — no existe en el alcance de este repositorio (el propio `README.md` raíz documenta que
  esta entrega usa MongoDB en todos los servicios; `docs/HISTORIAS_DE_USUARIO.md` menciona PostgreSQL en la
  redacción original de HT-02 porque describe la arquitectura *objetivo*, no lo implementado).
- **RabbitMQ** — es mensajería en tránsito, no el registro durable de datos del ciudadano. Ya tiene su
  propio mecanismo de "no perder nada" (reentrega + `EventReconciler`/`PendingRegistrationReconciler`,
  ver `docs/SEGURIDAD.md` §11), que es un problema distinto al de HT-02.

## Requisitos

- **Docker**, en ejecución. `mongodump`/`mongorestore`/`mongosh` corren dentro de contenedores `mongo:7`
  **desechables** (`docker run --rm`) — la misma imagen que ya usa `docker-compose.yml`. No se instala
  `mongodb-database-tools` como imagen aparte: `mongo:7` ya trae las herramientas (verificado:
  `mongodump version: 100.18.0`).
- **`tar`** del sistema (preinstalado en Linux/CI y en Git Bash de Windows — verificado: GNU tar 1.35). No
  se agrega ninguna dependencia npm de compresión.
- **Node.js 20+** y `npm install` dentro de esta carpeta (tiene su propio `package.json`, como cada
  microservicio).

## Variables de entorno

**MinIO — exactamente las mismas que ya usa `services/ms-documentos/src/config/env.js`, sin inventar
nombres nuevos:**

| Variable | Uso en `backup.js` | Uso en `restore-verify.js` |
|---|---|---|
| `S3_ENDPOINT` | endpoint de origen | endpoint de destino (o `--minio-endpoint`) |
| `S3_REGION` | región | región |
| `S3_BUCKET` | bucket de **origen** (por defecto `carpeta-documentos`) | *(no se usa: el bucket destino es `--minio-bucket`, siempre explícito)* |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | credenciales | credenciales |
| `S3_FORCE_PATH_STYLE` | estilo de ruta | estilo de ruta |

**Mongo:**

| Variable / opción | Uso |
|---|---|
| `MONGO_URI` o `--mongo-uri` | instancia de **origen** para `backup.js` (por defecto `mongodb://host.docker.internal:27017`, el puerto que `docker-compose.yml` ya publica al host) |
| `--mongo-uri` (obligatorio) | instancia **destino** para `restore-verify.js` — **sin valor por defecto**, ver "Seguridad" |

No se necesita ninguna credencial nueva: todo reutiliza lo que ya existe.

## Comando de backup

```bash
cd scripts/backup-restore
npm install        # una vez

node backup.js
# o, explícito:
node backup.js --mongo-uri="mongodb://host.docker.internal:27017" --out=./backups

node backup.js --skip-mongo      # solo MinIO (para probar rápido)
node backup.js --skip-minio      # solo Mongo
node backup.js --help
```

Produce `ht02-backup-<timestamp>.tar.gz` en `--out` (por defecto, el directorio actual), autocontenido:

```
backup-store/
├── manifest.json          # bucket, generatedAt, minio.{objects,errors}, mongo.{size,sha256,databases}
├── mongo.archive.gz        # mongodump --archive --gzip de la instancia completa
└── objects/
    └── <sha1(key)>.bin      # cada objeto de MinIO, con nombre derivado por hash (NUNCA la key cruda)
```

El manifest **nunca** contiene secretos (ni la URI de Mongo, que podría llevar credenciales, ni las
credenciales de S3): solo metadatos de lo respaldado.

## Comando de restore + verify

```bash
node restore-verify.js \
  --backup=ht02-backup-2026-09-24T03-16-49-601Z.tar.gz \
  --mongo-uri="mongodb://host.docker.internal:19700" \
  --minio-bucket=carpeta-documentos-restaurado

node restore-verify.js --backup=<archivo> --skip-mongo --minio-bucket=<bucket>   # solo MinIO
node restore-verify.js --help
```

`--mongo-uri` y `--minio-bucket` son **obligatorios y sin valor por defecto** (ver "Seguridad" abajo). El
destino de MinIO se resuelve contra `S3_ENDPOINT`/credenciales del entorno, o contra `--minio-endpoint` si
se quiere un MinIO distinto (p. ej. una instancia de MinIO totalmente aislada, no solo un bucket distinto).

## Cómo se verifica MongoDB

**No basta con que `mongorestore` termine en 0.** Al respaldar, `backup.js` además captura una **huella de
contenido** por base y colección — conteo de documentos y un SHA-256 del `EJSON.stringify()` concatenado de
cada documento (BSON-aware: distingue `Date`, `BinData`, `NumberDecimal`, etc., no solo el texto) — y la
guarda en `manifest.mongo.databases`. Tras `mongorestore`, `restore-verify.js` vuelve a capturar la MISMA
huella del destino ya restaurado y la compara contra la guardada:

- **bases** esperadas vs. reales (una base entera que falte se detecta),
- **colecciones** por base (una colección que falte se detecta, aunque la base exista),
- **conteo de documentos** por colección,
- **contenido** por colección (un conteo igual con contenido distinto **sí** se detecta — verificado con un
  test que arma ese escenario exacto).

Esto permite verificar sin que el Mongo de origen siga corriendo en ese momento (backup, restore y verify
pueden ocurrir en momentos distintos).

**Simplificación documentada** (no se oculta): la huella materializa cada colección completa en memoria
dentro de `mongosh` y la transmite entera por stdout, para hashear del lado de Node (`mongosh` no expone
`crypto`). Para el volumen de datos de este proyecto (curso, desarrollo local) es razonable y quedó
validado con datos reales de varios tipos BSON. A escala de producción con colecciones grandes, esto
necesitaría un hashing incremental (p. ej. vía *aggregation pipeline*) en vez de traer cada documento
completo.

## Cómo se verifica MinIO

Tras `PutObjectCommand` por objeto, `restore-verify.js` hace una verificación **independiente** (no confía
en lo que el propio restore reportó): vuelve a listar el bucket destino (`ListObjectsV2`, paginado) y
compara:

1. **conjunto de claves** origen vs. destino (una clave que falte, o una de más, se detecta),
2. **cantidad de objetos** y **bytes totales**,
3. por objeto: `HeadObjectCommand` (tamaño) + descarga completa + **SHA-256**, comparado contra el manifest,
4. `Content-Type`,
5. **metadata**, comparada como **conjunto de pares clave-valor**, nunca con `JSON.stringify()` directo —
   ver la nota siguiente.

### Hallazgo real: por qué la metadata NO se compara con `JSON.stringify()`

Validado experimentalmente antes de escribir esta implementación: MinIO no garantiza el orden de las
claves de `Metadata` al devolverlas (viajan como cabeceras HTTP `x-amz-meta-*`, que tampoco lo garantizan).
Subir `{owner, docId}` y recibir de vuelta `{docId, owner}` es un caso real, no hipotético, y
`JSON.stringify(a) === JSON.stringify(b)` da un **falso negativo** ahí. `src/metadataEqual.js` compara por
conjunto de pares, no por texto serializado (con test dedicado a este caso exacto).

## Integridad del propio backup, antes de restaurar

`manifest.json` incluye, para cada objeto de MinIO, `key + size + sha256 + localFile`, y para
`mongo.archive.gz`, `size + sha256`. Antes de restaurar **cualquier cosa**, `restore-verify.js` comprueba
que el archivo local exista, que su tamaño coincida y que su SHA-256 coincida con lo que el manifest
registró — si el backup en sí está corrupto, se detecta ahí, **antes** de escribir nada en el destino.

## Errores parciales

| Fase | Comportamiento |
|---|---|
| **Backup**, un objeto individual falla (p. ej. desapareció entre `ListObjectsV2` y `GetObject` — una carrera real, no hipotética, validada experimentalmente) | se registra en `manifest.minio.errors`, se **continúa** con los demás, el backup **nunca aparenta estar completo si no lo está** |
| **Backup**, Mongo o MinIO fallan por **completo** (no un objeto, todo el componente) | fallo **fatal** (código `1`): sin datos de una de las dos partes, HT-02 no se cumple |
| **Restore**, un objeto individual falla | se registra, se continúa con los demás |
| **Verify** (siempre corre después del restore, en la misma invocación) | vuelve a derivar la verdad **de forma independiente**: cualquier objeto/base/colección/documento que falte o no coincida se detecta aquí, **sin importar si el restore ya lo había reportado como error o no** |

## Códigos de salida

**`backup.js`**

| Código | Significado |
|---|---|
| `0` | Mongo y MinIO respaldados sin ningún error |
| `1` | fallo fatal — no se generó un backup utilizable (p. ej. Mongo o MinIO inalcanzables por completo) |
| `2` | backup generado, pero con errores **parciales** registrados en el manifest (algunos objetos no se pudieron capturar) — el backup no miente sobre lo que logró, pero no está 100% completo |

**`restore-verify.js`**

| Código | Significado |
|---|---|
| `0` | restaurado y verificado **sin ninguna diferencia** |
| `1` | fallo fatal (argumentos inválidos, destino no vacío sin `--force`, backup corrupto, Mongo/MinIO inalcanzables) **o** la verificación encontró diferencias |

`restore-verify.js` **no usa el código `2`**: es una decisión deliberada. Si la fase de *verify* encuentra
algo (un objeto faltante, un hash que no coincide, una colección de menos), eso es un **fallo de
integridad**, y debe ser ruidoso — código `1`, no un "éxito parcial" silencioso. La HT-02 pide exactamente
esto: que un restore con huecos "se convierta en fallo de integridad", no que se reporte como si hubiera
funcionado "casi".

## Seguridad

- **`--mongo-uri` y `--minio-bucket` en `restore-verify.js` no tienen valor por defecto.** A diferencia de
  `backup.js` (leer no es peligroso), aquí un valor por defecto silencioso podría apuntar sin querer al
  Mongo o al MinIO de desarrollo. Hay que indicarlos explícitamente siempre.
- **El destino debe estar vacío**, y esto se comprueba **consultando lo que realmente hay ahí**, no
  adivinando por el texto de la URI o el nombre del bucket (una convención se puede olvidar u omitir):
  - **Mongo**: si el destino ya tiene alguna de las 5 bases reales del proyecto (`ms-identidad`,
    `ms-documentos`, `ms-notificaciones`, `ms-interoperabilidad`, `ms-comparticion`), se rechaza con un
    mensaje que nombra exactamente cuáles encontró.
  - **MinIO**: si el bucket destino ya tiene al menos un objeto, se rechaza.
  - `--force` omite ambas comprobaciones, para el caso legítimo de reintentar sobre el mismo destino
    temporal.
- **Nunca se usa `--drop` en `mongorestore`**: la protección de "destino vacío" hace innecesario borrar
  nada primero.
- **Nunca se borra un bucket** ni se usa ninguna operación de borrado sobre el bucket real
  `carpeta-documentos`: el restore solo **escribe** (`PutObjectCommand`) al bucket destino, que siempre es
  explícito y distinto.
- **Ningún secreto se imprime ni se guarda en el manifest**: ni `S3_SECRET_ACCESS_KEY`, ni la URI de Mongo
  (que podría llevar credenciales), ni ningún JWT secret del resto del proyecto (esta herramienta no los
  usa ni los necesita).

## Compatibilidad Windows / Git Bash

**Los binarios de Mongo (`mongodump`/`mongorestore`) nunca reciben una ruta de archivo dentro del
contenedor.** Usan `--archive` **sin valor**, que lee/escribe por stdin/stdout — gestionado enteramente por
Node (streams). Esto elimina estructuralmente el problema de `MSYS_NO_PATHCONV` para Docker: no hay ningún
argumento `/tmp/...` que Git Bash pueda traducir mal, porque no se le pasa ninguno.

**`tar` sí tuvo un problema real, encontrado al probar esto de punta a punta** (no una precaución teórica):
el GNU tar que trae Git Bash interpreta un `:` en una ruta como sintaxis de host remoto para cintas
(`usuario@host:archivo`), así que `C:\Users\...\backup.tar.gz` lo confundía con un host llamado `C`
(`Cannot connect to C: resolve failed`). Se resolvió convirtiendo las rutas de Windows a la forma
MSYS/Cygwin (`/c/Users/...`) antes de pasarlas a `tar` (`src/archive.js`, función `toTarPath`) — es un
no-op en Linux/CI, y quedó cubierto con un test que empaqueta y desempaqueta de verdad con `tar` real,
incluyendo el caso con `:` en la ruta.

**No se necesita `MSYS_NO_PATHCONV=1` en ningún punto de esta implementación.**

## Limitaciones actuales

- **La huella de Mongo materializa colecciones completas en memoria** (ver "Cómo se verifica MongoDB"
  arriba) — razonable para este proyecto, no para datasets grandes. El workflow de CI hereda esta misma
  limitación: no está pensado para datasets enormes.
- **Sin autenticación en Mongo/MinIO local**, coherente con el resto del proyecto (`docs/SEGURIDAD.md`): es
  una herramienta pensada para desarrollo/CI, no para un backup de producción real (este proyecto académico
  no tiene un despliegue de producción definido).
- **Un backup/restore de CI solo prueba la restaurabilidad de los datos sembrados en esa misma corrida** (o
  de datos ya presentes en el Mongo/MinIO que use el workflow) — no respalda datos persistentes reales,
  porque este proyecto no los tiene fuera de desarrollo local.
- **Requiere Docker** para la parte de Mongo — no hay una ruta alternativa sin él (coherente con que todo
  el desarrollo local del proyecto ya depende de Docker).
- **No implementa almacenamiento externo permanente**: el `.tar.gz` solo vive como artefacto temporal de
  GitHub Actions (`retention-days: 14` en el workflow), no se sube a ningún almacenamiento duradero.
- **No implementa retención histórica de backups**: cada corrida es independiente; no hay un catálogo ni
  una política de cuántas versiones conservar.
- **No cifra el artefacto**: el `.tar.gz` que sube el workflow no está cifrado (coherente con que no
  contiene secretos — ver "Seguridad" — pero sí contiene los datos respaldados).
- **No reemplaza una estrategia de disaster recovery productiva**: demuestra que el mecanismo de
  backup/restore funciona de punta a punta sobre infraestructura efímera, no sustituye decisiones de
  negocio como RPO/RTO, replicación geográfica o retención regulatoria.

## Ejecución automática (GitHub Actions)

`.github/workflows/ht-02-backup-restore.yml` demuestra el ciclo completo de HT-02 de forma automática:

```
infraestructura temporal → seed → backup → destrucción de la fuente → destinos nuevos → restore → verify → artifact
```

**Triggers:** `workflow_dispatch` (para correrlo a demanda, p. ej. antes de una revisión) y `schedule` con
cron `0 7 * * 1` (todos los lunes, 07:00 UTC) — una frecuencia semanal, razonable para una "prueba periódica
automatizada" sin sobrecargar el runner compartido del curso.

**Qué hace, en orden:**

1. Levanta un Mongo y un MinIO **temporales** (`docker run`, sin volúmenes con nombre, sin `docker-compose`
   del proyecto): infraestructura completamente desechable, nunca la del desarrollo local ni ninguna real.
2. Siembra datos deterministas: 2 bases de Mongo con varios tipos BSON (`ObjectId`, `Date`, números,
   texto, booleanos, arreglos, objetos anidados, `null`) y varios objetos en MinIO (texto, binario, objeto
   vacío, clave con espacios, clave con caracteres especiales, objeto de varios MiB).
3. **Antes** de correr `backup.js`, captura una fuente de verdad **independiente** del propio backup: una
   huella de Mongo (propio `mongosh --eval` del workflow, no el código interno de `mongoBackup.js`) y un
   listado/hash de MinIO (propio script con `@aws-sdk/client-s3`, no el código interno de `s3Backup.js`).
4. Corre `backup.js` contra la infraestructura fuente.
5. **Destruye por completo la infraestructura fuente** (`docker rm -f`) y confirma que ya no responde,
   antes de tocar cualquier destino.
6. Crea Mongo y MinIO **destino, nuevos y vacíos** (contenedores/puertos distintos a los de la fuente; el
   bucket destino se llama `ht02-restore`, distinto del bucket de origen).
7. Corre `restore-verify.js` apuntando explícitamente a esos destinos (sin usar ningún valor por defecto).
8. Corre una **verificación adicional, independiente de la de `restore-verify.js`**: vuelve a capturar la
   huella de Mongo y el listado/hash de MinIO del destino ya restaurado, y los compara contra la fuente de
   verdad capturada en el paso 3 (no contra el `manifest.json` que generó el propio backup) — la
   herramienta que se está demostrando no es la única que certifica su propio resultado.
9. Si todo lo anterior pasó, publica el `.tar.gz` y el `manifest.json` como artefacto del workflow
   (`ht-02-backup-<run-number>`), para poder inspeccionar una corrida sin reproducirla localmente.
10. Limpia contenedores y archivos temporales en un paso `if: always()`, que nunca cambia el resultado ya
    determinado del job — solo libera recursos.

**Qué demuestra:** que un backup generado por `backup.js` es realmente restaurable en infraestructura
aislada y produce datos idénticos a los sembrados — no solo que el comando terminó sin error.

**Códigos de salida, interpretados por el workflow** (no se modifica el significado de estos códigos en
`backup.js`/`restore-verify.js` en sí — ver "Códigos de salida" arriba):

| Paso | Código | Resultado del job |
|---|---|---|
| `backup.js` | `0` | continúa |
| `backup.js` | `1` (fallo fatal) | falla el job |
| `backup.js` | `2` (éxito parcial) | **falla el job** — un backup automático parcial no se considera exitoso |
| `restore-verify.js` | `0` | continúa |
| `restore-verify.js` | cualquier otro código | falla el job |

**Infraestructura efímera:** todo lo que usa este workflow (Mongo, MinIO, red) se crea y se destruye dentro
de la misma corrida, en un runner `ubuntu-latest` de GitHub Actions — nunca depende de volúmenes locales ni
se conecta a ninguna infraestructura real del proyecto. Esto valida que el mecanismo de backup/restore
**funciona**, no reemplaza una estrategia de backup de producción (ver "Limitaciones actuales").

**Ejecución manual equivalente:** los pasos 4 y 7 del workflow son exactamente los comandos de "Comando de
backup" y "Comando de restore + verify" de este mismo README — el workflow no introduce ningún camino nuevo,
solo automatiza los mismos comandos sobre infraestructura desechable.
