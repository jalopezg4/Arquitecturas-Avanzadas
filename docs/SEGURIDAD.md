# Seguridad: secretos, TLS y rotación (HT-07, ADR-06)

Implementado en `ms-identidad`. Cada servicio nuevo debe replicar `src/config/`, `src/security/` y `src/transport/`.

## 1. Configuración y secretos

Toda la configuración pasa por un único módulo (`src/config/env.js`) y se valida al arrancar (`ConfigValidator`). Si algo está mal, **el servicio no arranca**, lista todos los problemas a la vez y nunca imprime el valor de un secreto.

Fuera de `development`/`test` se exige:
- `JWT_SECRET` de al menos 32 caracteres, con variedad, que no sea un placeholder (`cambiar-en-produccion`, valores de ejemplo, el secreto de desarrollo). Generar con `openssl rand -hex 32`.
- `GOVCARPETA_BASE_URL` con `https://`, `RABBITMQ_URI` con `amqps://`, `MONGO_URI` con TLS (`mongodb+srv://` o `?tls=true`).
- Sin contraseñas por defecto en las URIs (`guest:guest`, `admin:admin`, ...).
- Mongo no puede desactivar TLS ni la validación del certificado: se rechazan `tls=false`, `ssl=false`, `tlsInsecure=true`, `tlsAllowInvalidCertificates=true`, `tlsAllowInvalidHostnames=true` y `sslValidate=false` (incluso con `mongodb+srv://`, que activa TLS por defecto pero se puede apagar).

> **`NODE_ENV` es obligatorio y falla cerrado.** Si no está definido el servicio **no arranca** (no se asume `development`). Antes se asumía desarrollo, lo que permitía que un despliegue que olvidara la variable usara una llave conocida y no exigiera TLS. Para desarrollo local se define en `.env` (`.env.example` ya trae `NODE_ENV=development`); `docker-compose` y `jest` ya lo definen. Cualquier valor distinto de `development`/`test` (`staging`, `production`, un typo...) activa las validaciones estrictas.

**"Gestionadas de forma centralizada":** los secretos se inyectan como variables de entorno desde un único lugar (GitHub Secrets para CI, variables de la plataforma de despliegue) y el código solo los lee de `env.js`. No hay un gestor de secretos dedicado (Vault, AWS Secrets Manager); ver límites.

**Escáner de secretos:** `npm run scan:secrets` falla si encuentra credenciales en código o configuración desplegable (llaves privadas, access keys de AWS, URIs con contraseña, `password = "literal"`; en `.env`/YAML/Dockerfile también valores **sin comillas** como `JWT_SECRET=valor`. Los placeholders documentados, `${VAR}` y valores vacíos se ignoran). Corre en CI antes de los tests. Un valor de desarrollo documentado se marca con `secret-scan:allow`. Los hallazgos nunca muestran el valor.

## 2. Transporte cifrado

| Modo | Cómo se activa | Uso |
|---|---|---|
| HTTP | sin variables TLS | detrás de una plataforma que termina TLS (Render, Railway) o en desarrollo |
| TLS 1.3 | `TLS_CERT_PATH` + `TLS_KEY_PATH` | el servicio sirve HTTPS |
| mTLS | además `TLS_CA_PATH` | se exige certificado de cliente firmado por esa CA (tráfico entre servicios) |

`REQUIRE_TLS=true` impide arrancar sin certificado. Verificado con un servicio real: con mTLS responde 200 al cliente con certificado válido y rechaza al que no trae certificado, al de otra CA, al que solo habla TLS 1.2 y al HTTP plano.

**Alcance real:** en las plataformas de curso el tráfico interno entre contenedores lo gestiona la plataforma, y mTLS entre servicios solo es viable donde se puedan montar certificados. El mecanismo está listo y probado; activarlo depende del ambiente. El expediente lo describe igual: "TLS interno, según lo que el ambiente de despliegue soporte".

## 3. Rotación de credenciales sin downtime

### Llave JWT (implementado: `SecretsManager`)
Se firma siempre con la llave activa y se verifica con la activa **y las anteriores**.

**Rotar en un solo paso NO es seguro con varias réplicas.** Si se despliega `JWT_SECRET=<nueva>` + `JWT_SECRET_PREVIOUS=<vieja>` de golpe, durante el despliegue gradual las réplicas nuevas firman con la llave nueva y las réplicas que aún no se actualizaron no la conocen: rechazan esos tokens y el usuario cuya petición cae en una réplica vieja pierde la sesión. (Demostrado en `tests/SecretsManager.test.js`.) Por eso se rota **en tres fases**:

1. **Distribuir la llave nueva solo para verificar.** Desplegar en *todas* las réplicas `JWT_SECRET=<vieja>` (sigue firmando) y `JWT_SECRET_PREVIOUS=<nueva>` (ya la reconocen). Esperar a que **todas** estén actualizadas.
2. **Cambiar la llave que firma.** Desplegar `JWT_SECRET=<nueva>` y `JWT_SECRET_PREVIOUS=<vieja>`. En cualquier punto del despliegue gradual toda réplica, vieja o nueva, acepta todo token vigente.
3. **Retirar la llave vieja** cuando haya expirado el token más longevo: **`JWT_REFRESH_EXPIRES_IN` (7 días por defecto)**. Desplegar sin `JWT_SECRET_PREVIOUS`; los tokens firmados con la vieja dejan de valer.

Cada token lleva un `kid` (hash de la llave, no el secreto) y el algoritmo está fijado a HS256. Al arrancar se registra `jwt.llavero` con los ids de llave activa y anteriores: sirve para confirmar en qué fase está cada réplica antes de pasar a la siguiente.

### Credenciales de Mongo y RabbitMQ (solo procedimiento, no automatizado)
Crear un segundo usuario con los mismos permisos, desplegar con sus credenciales, comprobar y revocar el usuario anterior. El servicio no rota estas credenciales por sí mismo.

## 4. URLs prefirmadas (ADR-06)

Política de expiración configurable y validada al arrancar: `PRESIGNED_URL_AUTH_TTL_SECONDS` (autenticación en GovCarpeta, tope 900 s) y `PRESIGNED_URL_DOWNLOAD_TTL_SECONDS` (descarga del ciudadano, tope 3600 s). Un valor por encima del tope impide arrancar. Todavía no existe almacenamiento de objetos: HU-03/HU-04/HU-09 deben leer estos valores, y el bucket debe configurar su propia política.

## 5. Sesiones: login, tokens y bloqueo (HU-02)

`POST /api/v1/auth/login` recibe `{documento, password}` y responde `200 {accessToken, refreshToken, expiresIn: 900}` (con `Cache-Control: no-store`).

| Aspecto | Decisión |
|---|---|
| Contraseña | Se verifica con **Argon2id** contra el resumen guardado. Un resumen de otra variante (`argon2i`/`argon2d`) **no autentica**, aunque la contraseña sea correcta (`argon2.verify` aceptaría la variante que indique el prefijo del hash). Nunca se guarda ni se registra la contraseña |
| Access token | JWT de **15 minutos** (`typ: access`). `JWT_ACCESS_EXPIRES_IN` no puede superar 15 m: el servicio **no arranca** si se configura más (p. ej. `24h`) |
| Refresh token | JWT de mayor vigencia (`JWT_REFRESH_EXPIRES_IN`, 7 d por defecto; debe ser mayor que el de acceso). **Un solo uso**: `POST /api/v1/auth/refresh` lo canjea por un par nuevo |
| Contenido del token | `sub` = id interno del ciudadano, `iss`, `typ`, `jti`. **No** lleva documento, correo ni nada personal (un JWT está firmado, no cifrado) |
| Error de credenciales | Siempre `401 {"error":"credenciales invalidas"}`, sin distinguir documento inexistente, contraseña incorrecta, cuenta bloqueada o no activa |
| Enumeración por tiempo | Si el documento no existe se verifica igual contra un resumen Argon2id descartable: la respuesta tarda lo mismo |
| Bloqueo | Al **5.º intento fallido** la cuenta se bloquea **15 minutos**. Durante el bloqueo hasta la contraseña correcta se rechaza (mismo 401), **sin contar más intentos** (así un atacante no puede mantener bloqueada a la víctima indefinidamente). Al vencer, el contador empieza de cero |
| Atomicidad | El contador y el bloqueo se actualizan en una sola operación de Mongo; intentos simultáneos no se pierden (probado con 8 fallos en paralelo). Además, **la decisión de aceptar un login es atómica**: la verificación Argon2 tarda, y si durante ese tiempo la cuenta se bloquea (o deja de estar activa) el login que ya venía en curso se rechaza en vez de usar el estado que leyó antes de esperar |
| Bitácora | Cada intento queda en `audit_logs` (`ciudadano.login`): éxito, fallo, rechazo (`cuenta_bloqueada`, `estado_*`, `documento_no_registrado`) con el `traceId` |

**Rotación del refresh token.** Cada login abre una **sesión** (`refreshsessions`) y el refresh token lleva su `fam` (la sesión) y su `jti`. La sesión guarda un único `currentJti`: solo el token que lleva el `jti` vigente puede canjearse, y el canje es una **comparación-y-cambio atómica** sobre ese único documento (el `jti` vigente pasa al del token nuevo en la misma operación). Si alguien presenta un refresh token que ya no es el vigente, se interpreta como posible robo: se **revocan todas las sesiones** del ciudadano, se registra `refresh_reutilizado` en la bitácora y hay que iniciar sesión de nuevo. Solo se guardan identificadores (nunca el token) y un índice TTL purga la sesión al expirar. Una cuenta bloqueada o que ya no está `activa` (p. ej. transferida) tampoco renueva sesión.

Por qué una sesión y no un registro por token: con "marcar usado" y "emitir el nuevo" como pasos separados, en dos canjes concurrentes el perdedor podía revocar *antes* de que el ganador creara su token, y ese token nacía válido. Con la sesión como único documento no hay hueco entre consumir y emitir: si la revocación ocurre en cualquier momento, el token que se llevó el ganador queda inválido (probado forzando ese orden exacto). Consecuencia conocida: dos canjes simultáneos del mismo token (p. ej. doble clic) hacen que uno gane y el otro dispare la revocación; se prefiere cerrar sesiones de más que dejar un token robado vivo.

**Cada servicio valida el token por sí mismo (ADR-06).** `src/security/requireAuth.js` verifica firma (llavero de la sección 3, algoritmo fijado a HS256), expiración, emisor y que sea un token de **acceso**: un refresh token no sirve para llamar a la API. Cada microservicio debe montarlo con **su propio** `SecretsManager` (misma llave compartida), sin llamar a `ms-identidad` ni confiar en que el gateway ya validó. Probado con un segundo servicio simulado: acepta el token válido (también tras rotar la llave), rechaza el expirado, el firmado con otra llave, `alg=none`, el alterado y el refresh.

## 6. Gateway (`ms-gateway`, HU-02)

Único punto de entrada. Por cada petición: asigna o propaga el `x-trace-id`, busca la ruta en una **lista blanca** (`src/routes.js`; lo que no está declarado responde `404` y **nunca se reenvía**, tampoco por otro método), y si la ruta no es pública exige un **access token válido antes de contactar al servicio** (mismo criterio que `requireAuth`: firma, expiración, emisor y tipo de token). Luego reenvía la petición con el `Authorization` intacto: **cada microservicio vuelve a validarlo** (ADR-06), el gateway es la primera barrera y no la única.

| Ruta | Acceso |
|---|---|
| `POST /api/v1/citizens`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh` | públicas (no se puede exigir token para pedirlo ni para registrarse) |
| `GET /api/v1/auth/me` | requiere access token |

- **Misma llave que `ms-identidad`:** `JWT_SECRET` (y `JWT_SECRET_PREVIOUS` durante una rotación) debe ser idéntica; el gateway usa el mismo `SecretsManager` y la misma validación de arranque (fallo cerrado, sin `NODE_ENV` no arranca, llave débil rechazada fuera de local). Al rotar, el orden de la sección 3 aplica también al gateway.
- **Errores del destino:** destino caído → `502`, sin respuesta a tiempo → `504` (`UPSTREAM_TIMEOUT_MS`), siempre `{"error":"servicio no disponible"}` sin filtrar host, puerto ni traza.
- **No parsea el cuerpo:** pasa como flujo hacia el servicio destino, sin reescribirlo.
- **Servicios nuevos:** agregar la URL en `src/config/env.js` (`upstreams`) y sus rutas en `src/routes.js`. Todo lo que no se declare queda cerrado por defecto.

## 7. Documentos: carga (`ms-documentos`, HU-03)

`POST /api/v1/citizens/:id/documents` (multipart: campo `archivo` + `titulo`, `entidadAvaladora`, `fecha`, opcional `solicitudId`) responde `201 {documentoId, url}`.

**Orden de las barreras** (quien no debe no hace que el servicio lea nada): 1) token válido, **revalidado en este servicio** además del gateway (ADR-06) → 2) el `sub` del token debe ser el `:id` de la carpeta, si no `403` y queda en la bitácora como `no_es_dueno` (RNF-07) → 3) recién entonces se lee el archivo → 4) validación → 5) cuota → 6) storage.

| Aspecto | Decisión |
|---|---|
| Tipo de archivo | Solo PDF. Se exige el tipo declarado **y** la firma real (`%PDF-`): un ejecutable renombrado se rechaza (`415`) |
| Tamaño | `MAX_UPLOAD_BYTES` (10 MB por defecto, tope duro 50 MB) → `413`. Un solo archivo, campo `archivo`; más archivos o campos → `400` |
| Clave en el storage | `ciudadanos/<ciudadanoId>/<uuid>.pdf`. **Nada que envíe el usuario** (nombre de archivo, título) entra en la clave: sin recorrido de rutas ni colisiones entre ciudadanos |
| Qué se guarda en Mongo | Solo metadatos y la **clave** del objeto, nunca el binario. Además la huella SHA-256 (base de la autenticación, HU-04) |
| Cuota (RNF-04) | `QUOTA_NO_CERTIFICADOS` (5) por ciudadano, solo para documentos `temporal`; los `certificado` no cuentan. El cupo se **reserva de forma atómica** antes de subir nada (contador en Mongo con incremento condicional): 10 cargas simultáneas con cuota 5 dan exactamente 5 éxitos y 5 `409`, y el rechazado nunca sube el archivo |
| Fallos a mitad de camino | Compensación: si falla el storage se devuelve el cupo (`503`); si falla guardar los metadatos se **borra el objeto** subido y se devuelve el cupo |
| URL de descarga | Prefirmada, **1 hora como máximo** (ADR-06), firmada para el endpoint *público* del storage. Alterar la clave da `403` |
| Evento `documento.cargado` | Se publica **después** de guardar; la respuesta no espera al consumidor. Si el broker no confirma en `EVENT_PUBLISH_TIMEOUT_MS` o lo rechaza, la carga **no falla** (ADR-04): el documento queda con `eventoPublicado: false` para reconciliar. Lleva un `eventId` para que el consumidor sea idempotente |
| Trazabilidad | `multer` procesa el cuerpo con eventos de stream que salen del contexto asíncrono; se **restaura** el trace-id después de leer el archivo (si no, el servicio, los logs y la bitácora lo perdían: lo detectó una prueba) |
| Logs y bitácora | Sin título, entidad ni contenido; solo identificadores |

**El storage debe rendirse antes que el gateway.** El SDK de S3 reintenta por defecto durante mucho más que el plazo del gateway (10 s) y, además, **solo avisa** al pasarse del `requestTimeout` sin abortar la petición: con el storage caído el cliente veía un `504` y la carga terminaba igual cuando el storage volvía (un reintento del cliente habría duplicado el documento y la cuota). Ahora el cliente S3 usa 2 intentos, `throwOnRequestTimeout` y plazos cortos (`S3_CONNECT_TIMEOUT_MS`, `S3_REQUEST_TIMEOUT_MS`), y el arranque **rechaza** una configuración cuyos 2 intentos no quepan antes del gateway. Verificado con MinIO real: con el storage caído responde `503` en 3–6 s, la cuota queda exacta y no aparecen documentos fantasma.

**Configuración de producción** (validada al arrancar): `S3_ENDPOINT` con `https://`, credenciales de storage obligatorias y que no sean las de tutorial (`minioadmin`...), bucket válido, `JWT_SECRET` fuerte y **el mismo que usa `ms-identidad`**.

## 8. Notificaciones: consumo de eventos y correo (`ms-notificaciones`, HU-03 y HU-01)

`ms-notificaciones` no expone API de negocio: consume `documento.cargado` (confirma la carga al ciudadano, RF-21) y `ciudadano.registrado` (guarda a quién avisar y da la bienvenida). Solo publica `/health` y `/ready`.

| Aspecto | Decisión |
|---|---|
| A quién escribir | Copia **local** (`contacts`) de lo que publica `ms-identidad`: el evento `ciudadano.registrado` ahora lleva `nombre` y `correo` (antes no, y sin ellos no había a quién avisar). Nunca lleva el password ni su resumen (hay prueba) |
| Idempotencia (RabbitMQ entrega "al menos una vez") | Cada aviso tiene una clave **única** por evento. Se **reclama de forma atómica** antes de enviar: 10 entregas simultáneas del mismo evento mandan exactamente 1 correo. Un aviso `fallido` se retoma al reentregarse; uno `enviando` abandonado (más viejo que `NOTIFICATION_STALE_CLAIM_MS`) lo retoma otro proceso; uno `enviado` nunca se reclama de nuevo |
| Fallo del correo | Es transitorio: el mensaje vuelve a la cola con **retroceso exponencial** (1, 2, 4… hasta 60 s) y un **tope de 8 intentos**; agotado, va a la cola de fallidos con el motivo. Sin ese tope el servicio reintentaba cada segundo para siempre (lo mostró la prueba real con el SMTP caído: 5 intentos en 14 s con retroceso, ~14 con pausa fija) |
| Mensajes imposibles de procesar | JSON inválido, campos faltantes, ciudadano sin contacto: van **directo** a `<cola>.fallidos` (sin reintentar) con `x-motivo-fallo`. Las colas las declaran también los publicadores (para que los mensajes esperen aunque este servicio no corra) y RabbitMQ rechaza redeclararlas con otros argumentos: por eso **el propio consumidor republica** en la cola de fallidos y solo entonces hace ACK; si no puede republicar, devuelve el mensaje (nunca se pierde) |
| Correo | Puerto `EmailSender`: `console` (desarrollo: no envía, deja el aviso en Mongo) o `smtp` (nodemailer). **Fuera de local se exige `smtp`**: con `console` un aviso se marcaría "enviado" sin que nadie lo reciba. SMTP con `starttls` **no envía en claro** si el servidor no ofrece TLS (verificado contra un SMTP real); `SMTP_SECURITY=none` está prohibido fuera de local; plazos de conexión y de socket para no colgarse |
| Texto del ciudadano en el correo | Se sanea (sin saltos de línea ni caracteres de control) y se recorta: un título con `\r\nBcc: ...` no puede agregar encabezados. Un correo con salto de línea o con varios destinatarios se rechaza |
| Datos personales | El registro del aviso guarda tipo, estado, intentos y **asunto**, nunca el correo ni el cuerpo. Los logs no contienen correo, nombre ni título (hay prueba) |
| Trazabilidad | Retoma el `x-trace-id` del mensaje: el trace-id de la carga aparece en gateway, `ms-documentos` y `ms-notificaciones` |
| Resiliencia | Si RabbitMQ cae, los consumidores **reconectan solos** con espera creciente (verificado reiniciando el broker); si no está disponible al arrancar, el servicio no cae |

## Límites (qué NO cubre)

- **Sin gestor de secretos** dedicado ni rotación automática de secretos: es rotación asistida por configuración.
- **mTLS/TLS interno no está activado** en ningún despliegue; solo está implementado y probado.
- **Solo `ms-identidad`**: el criterio "credenciales por servicio" y el tráfico entre servicios reales no se pueden demostrar hasta que existan otros servicios.
- El escáner detecta patrones comunes, no todo secreto posible; no sustituye una revisión ni un escáner de historial de git.
- Las URLs prefirmadas están solo como política de configuración, sin uso todavía.
- **Llave simétrica compartida (HS256):** todo servicio que verifica tokens conoce la llave que también firma. Un servicio comprometido podría emitir tokens. Pasar a llaves asimétricas (RS256/ES256, con clave pública en cada servicio) es la mejora natural; queda fuera de esta entrega.
- **Sin cierre de sesión ni revocación del access token:** un access token robado vale hasta 15 minutos. Se revocan los refresh tokens solo ante reutilización; no hay `logout` (no está en la HU).
- **El bloqueo es por cuenta, no por origen:** un atacante que conozca un documento puede bloquear esa cuenta 15 minutos con 5 intentos (denegación temporal). No hay limitación por IP: correspondería al gateway.
- **Documentos (HU-03):** no hay análisis antivirus ni de contenido del PDF (solo tipo, firma y tamaño); el cifrado en reposo lo da el proveedor de storage, no el servicio; si el broker falla, el evento queda marcado `eventoPublicado:false` pero **no hay aún un proceso que lo reenvíe** (reconciliación manual); un `504` del gateway con una carga ya terminada por el servicio sigue siendo posible en un caso límite (el servicio se rinde antes, por configuración, pero no está garantizado por construcción); la carga certificada por una entidad emisora (HU-10) y la eliminación de documentos (que devolvería cupo) no están implementadas.
- **Notificaciones (HU-03):** el contador de intentos por mensaje vive en memoria (si el proceso reinicia, la cuenta vuelve a empezar; solo alarga el reintento); un aviso enviado cuyo registro `enviado` no se pudo guardar y cuyo reclamo se vuelve "abandonado" podría reenviarse una vez pasado `NOTIFICATION_STALE_CLAIM_MS` (correo duplicado, nunca perdido); solo correo (no hay SMS ni bandeja del portal); no hay reproceso automático de la cola de fallidos (es manual); la bienvenida solo se envía para ciudadanos registrados con el evento ya enriquecido (los eventos antiguos, sin correo, van a fallidos); el `ciudadano.registrado` lleva nombre y correo por el broker interno (TLS fuera de local).
- **`ms-gateway` es mínimo:** valida tokens, enruta por lista blanca, propaga el trace-id y expone TLS/mTLS opcional, pero no hace limitación de tasa (por IP o por cliente), no tiene circuit breaker ni balanceo entre réplicas de un mismo servicio, y sus rutas están en código (`src/routes.js`), no en una configuración dinámica. Como se dijo arriba, la limitación por origen (el bloqueo de cuentas por IP) le correspondería.
