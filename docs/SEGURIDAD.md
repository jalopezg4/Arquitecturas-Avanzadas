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

Política de expiración configurable y validada al arrancar: `PRESIGNED_URL_AUTH_TTL_SECONDS` (autenticación en GovCarpeta, tope 900 s) y `PRESIGNED_URL_DOWNLOAD_TTL_SECONDS` (descarga del ciudadano, tope 3600 s). Un valor por encima del tope impide arrancar. Hoy los usan `ms-autenticacion` (HU-04, 15 min exactos para GovCarpeta) y `ms-documentos` (HU-03/HU-09 descarga del ciudadano, HU-05c URLs de transferencia; 1 h). El bucket debe configurar además su propia política.

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

## 7. Documentos: carga y consulta (`ms-documentos`, HU-03 y HU-08)

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

**Consulta (HU-08).** `GET /api/v1/citizens/:id/documents` sigue el mismo orden que la carga: token válido revalidado en el servicio → el `sub` debe ser `:id` (`403` y registro en la bitácora si no) → recién entonces se consulta. Además del control de la ruta, la consulta a Mongo **filtra por el ciudadano del token** (defensa en profundidad: aunque se rompiera el control de la ruta, no saldrían documentos ajenos; ambas protecciones tienen pruebas que fallan si se quitan). `page` y `pageSize` se validan de forma estricta (entero positivo de hasta 9 dígitos; nada de `1e3`, decimales, arreglos ni objetos como `page[$gt]=`, que no llegan a Mongo) y `pageSize` se limita a 100. La respuesta **no expone** la clave del storage, la huella ni el `ciudadanoId`; la descarga con URL prefirmada es HU-09.

**Configuración de producción** (validada al arrancar): `S3_ENDPOINT` con `https://`, credenciales de storage obligatorias y que no sean las de tutorial (`minioadmin`...), bucket válido, `JWT_SECRET` fuerte y **el mismo que usa `ms-identidad`**.

**Descarga (HU-09).** `GET /api/v1/documents/:id/download` responde `200 {documentoId, titulo, mimeType, downloadUrl, expiraEn}` con `Cache-Control: no-store` (la URL es una credencial temporal). Orden: token de ciudadano revalidado aquí → el documento existe (`404`, también para un id mal formado) → es del ciudadano del token (`403`, sin firmar nada, y bitácora `documento.descargar` / `no_es_dueno`) → recién entonces se firma. La URL es prefirmada, de lectura y vence en `PRESIGNED_URL_DOWNLOAD_TTL_SECONDS` (1 hora como máximo, ADR-06): el mismo mecanismo que HU-04 con vigencia propia. **Cada descarga exitosa queda en la bitácora** (RF-39): quién, qué documento y cuándo; lo que la bitácora no puede saber es cuántas veces se usa la URL dentro de su hora de vigencia (el storage la sirve sin pasar por el servicio). Funciona también con la carpeta en transferencia (es de solo lectura).

### 7.1 Recepción de un documento enviado por una entidad emisora (HU-10, RF-11)

`POST /api/v1/documents/inbound` (multipart: `archivo` + `destinatario`, `envioId`, `titulo`, `entidadAvaladora`, `fecha`; opcional `solicitudOficialId`, HU-06.4, sección 16) responde `201 {documentoId, duplicado:false}`.

**Orden de las barreras**, el mismo principio que HU-03 pero con la cadena institucional (ADR-07): 1) token **institucional** válido, revalidado aquí además del gateway → `401` → 2) la entidad está **verificada** por el operador → `403` → 3) recién entonces se lee el archivo → 4) se resuelve el destinatario → 5) validación y almacenamiento.

| Aspecto | Decisión |
|---|---|
| **Quién entrega** | Sale del `sub` del token institucional firmado. **Nunca del cuerpo**: `entidadAvaladora` es texto de presentación autodeclarado; el dato confiable es `emisorInstitutionId` |
| **A quién** | Por su **dirección única**, resuelta contra la copia local de la carpeta (`Folder.direccionUnica`, alimentada por `ciudadano.registrado`). **Un `ciudadanoId` en el cuerpo se ignora**: no hay forma de elegir destinatario que no sea conocer su dirección |
| Dirección desconocida | `404` con el **mismo mensaje** que una dirección mal formada: no se confirma ni se niega quién está afiliado aquí. La dirección lleva 8 hex aleatorios, así que no es adivinable a partir de la cédula |
| Estado y cuota | Entra directo en `certificado`: no pasa por `temporal` y **no consume la cuota** del ciudadano (RNF-04) |
| Dueño | El **ciudadano**, siempre. La clave en el storage es `ciudadanos/<ciudadanoId>/<uuid>.pdf` y el documento aparece en su consulta (HU-08) |
| Lo que NO se devuelve | Ninguna URL prefirmada: la entidad entrega un documento, no gana acceso de lectura a una carpeta ajena |
| Tipo de archivo | Igual que HU-03: PDF declarado **y** firma real `%PDF-` |
| **Tamaño** | `MAX_INBOUND_UPLOAD_BYTES` (50 MB por defecto) → `413`. **Desviación consciente del criterio de la HU** (ver abajo) |
| **Idempotencia** | La entidad elige un `envioId`. Reintento idéntico → `200` con el **mismo** `documentoId`, sin volver a subir el archivo; mismo `envioId` con otro contenido u otro destinatario → `409`, sin pisar nada. Un índice **único parcial** `(emisorInstitutionId, envioId)` cierra la carrera entre peticiones simultáneas |
| Bitácora | `documento.recibir` con `actorType: "entidad"`, `actor` = institución, `resourceOwner` = ciudadano y **`delegated: true`**. Sin esa marca, `verifyNoOutOfPolicyAccess()` contaría cada entrega legítima como violación de RNF-07 |
| Evento | El **mismo** `documento.cargado` de HU-03, para reutilizar el consumidor de `ms-notificaciones` sin tocarlo. Si el broker no confirma, la entrega no falla: se reconcilia (ADR-04) |
| Logs | Sin dirección única, sin título y sin contenido; solo el id de la institución |

**El "sin límite de tamaño" del criterio de aceptación no se implementó literalmente.** El archivo se procesa **entero en memoria** (`multer.memoryStorage`, que es como está construido el camino de carga desde HU-03) y la huella SHA-256 se calcula sobre ese buffer. Sin tope, una sola petición puede agotar la memoria del servicio — y no hay limitación de tasa en ningún punto del sistema. Quitarlo de verdad exige subir al storage por partes (*streaming multipart*), hash incremental y releer la firma del PDF del primer trozo: un rediseño del camino de carga, fuera del alcance de estos 8 puntos. Se deja un límite **configurable y más alto que el del ciudadano** (50 MB, el tope duro que ya validaba el arranque), y el validador rechaza un valor mayor que ese tope o menor que `MAX_UPLOAD_BYTES`.

**Riesgo residual aceptado:** una entidad verificada puede hacer **envíos ilimitados** a cualquier carpeta cuya dirección conozca. Los certificados no consumen cuota y HU-10 no define ninguna regla de volumen, así que no se inventó ninguna: queda la trazabilidad completa en la bitácora (quién entregó qué, a quién y cuándo) como control compensatorio.

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

## 9. Directorio de operadores (`ms-interoperabilidad`, HU-05a)

Copia local del directorio de GovCarpeta (`GET /apis/getOperators`, ADR-03) para localizar al operador destino de una transferencia y resolver su dirección de transferencia. Es de **solo lectura** hacia GovCarpeta.

**Política de refresco** (el issue pedía definirla):

| Situación | Qué hace |
|---|---|
| La copia tiene menos de 60 min (`OPERATOR_DIRECTORY_TTL_MINUTES`) | La usa, sin llamar a GovCarpeta (5 búsquedas seguidas = 1 llamada; sobrevive a reinicios porque vive en Mongo) |
| La copia es más vieja | Refresca **antes** de usarla. Varias consultas simultáneas comparten **un solo** refresco |
| Operador no encontrado, o sin dirección publicada | **Un** refresco forzado (pudo registrarse o publicar hace poco: el directorio es compartido y cambia), pero no más de uno cada 30 s (`MIN_FORCED_REFRESH_SECONDS`): pedir operadores inexistentes en bucle no debe martillar al sandbox compartido |
| GovCarpeta no responde y hay copia (≤ 24 h, `OPERATOR_DIRECTORY_MAX_STALE_MINUTES`) | **Buscar** devuelve la copia marcada `stale: true`. **Resolver una dirección de transferencia NO**: se le van a enviar datos de un ciudadano, así que nunca se usa una dirección que no se pudo confirmar vigente |
| GovCarpeta no responde y no hay copia utilizable | `DirectoryUnavailableError` |
| GovCarpeta devuelve una lista **vacía** | No reemplaza a un directorio bueno (parece una falla, no un directorio sin operadores) |

**El refresco se publica de forma atómica.** Cada refresco escribe una *generación* nueva completa y solo al final cambia el puntero (`DirectoryState`); si algo falla a mitad, el directorio anterior sigue intacto y no queda una generación huérfana. Los operadores que dejan de aparecer en GovCarpeta desaparecen de la copia.

**Las direcciones las publican OTROS operadores (no confiables)** y luego se les enviarán datos de un ciudadano. Antes de devolver una dirección se valida: solo `http`/`https`, sin credenciales en la URL, sin espacios ni caracteres de control, longitud acotada, y **sin IPs ni nombres locales o privados** (loopback, `10.x`, `172.16–31`, `192.168`, link-local y metadatos de la nube `169.254.169.254`, CGNAT, IPv6 local, IPv4 mapeada a IPv6, y las formas ofuscadas `2130706433`, `0x7f000001`, `127.1`, `0177.0.0.1`, que el parser normaliza). `ALLOW_PRIVATE_OPERATOR_URLS` solo puede activarse en local: el arranque lo **prohíbe** fuera de local. `REQUIRE_HTTPS_OPERATOR_URLS` está apagado por defecto porque varios operadores del curso publican `http://`.

**Datos reales que motivaron el diseño** (directorio del sandbox, 2026-09-19): 73 operadores, solo 16 con dirección de transferencia, **un operador publicó una dirección con IP privada** (la política la rechaza; las otras 15 pasan) y hay **nombres repetidos** (p. ej. "Operador 123" ×10): buscar por nombre devuelve `AmbiguousOperatorError` y hay que usar el `operatorId`.

**Sobre las mayúsculas del Swagger:** `getOperators` documenta `OperatorId`/`OperatorName` pero el sandbox real devuelve `_id`/`operatorName` (y `registerCitizen` envía `operatorId`/`operatorName`). El cliente acepta todas las formas; una prueba específica cubre la diferencia.

**Nuestro propio operador** (`OPERATOR_ID`) nunca puede ser el destino (`SelfTransferError`).

**Publicación de nuestro endpoint (HU-05b, `npm run publish:endpoint`).** Modifica el registro de nuestro operador en GovCarpeta, así que: **simulación por defecto** (`--confirm` para publicar), falla **antes de enviar** si falta el `OPERATOR_ID` de HU-11, si no existe en el directorio o si **ya hay una dirección publicada** (`--replace` es una decisión explícita), y las direcciones que verán otros operadores pasan la **misma política de URLs** (no `localhost`, ni redes privadas, ni credenciales en la URL). Si la respuesta se pierde, relee el directorio antes de dar la publicación por fallida. El cliente que **escribe** está separado del que **lee** el directorio, y una prueba comprueba que el servicio de lectura no lo importa.

## 10. Instituciones (`ms-comparticion`, HU-06.1)

`POST /api/v1/institutions` registra una entidad institucional (notaría, universidad, empresa) y le asigna una **carpeta institucional propia**. Responde `201 {institutionId}` y no expone datos internos.

**El riesgo principal: el registro es autodeclarado.** El issue pide que la propia entidad se registre (`POST` público) y HU-06.2 entregará **documentos de ciudadanos** a esa carpeta. Sin un proceso de verificación (el caso de estudio no lo define), cualquiera podría registrarse como "Universidad X" y recibir documentos que no le corresponden. Mitigaciones implementadas y lo que NO se resuelve:

| Medida | Estado |
|---|---|
| NIT **único** (índice único en Mongo) y validado con su **dígito de verificación real** (módulo 11 de la DIAN, comprobado con NIT reales); las formas con/sin puntos y con/sin dígito son el mismo NIT | ✅ 8 registros simultáneos → 1 creado + 7 × `409` |
| Cada entidad nace con `verificada: false` (no se puede fijar desde el cliente: prueba de *mass assignment*) | ✅ un proceso de verificación futuro puede distinguirlas |
| `REGISTRATION_TOKEN` **opcional**: si se define, hay que enviar `x-registration-token` (comparación en tiempo constante, **antes** de leer el cuerpo, así un no autorizado con un cuerpo inválido recibe `401` y no aprende nada). El token debe ser fuerte (≥ 24 caracteres, sin placeholders) y nunca aparece en logs | ✅ el operador se lo entrega a cada institución al afiliarla |
| Bitácora de cada registro y de cada duplicado (`institucion.registrar`, actor `entidad`) con el `traceId` | ✅ |
| **Verificar que la entidad es quien dice** | 🟡 **resuelto como decisión humana registrada** (ADR-07): el operador verifica fuera de banda con `npm run verify:institution` y sin esa verificación la entidad no puede ejecutar operaciones sensibles (sección 12). Lo que **sigue sin resolverse** es la comprobación automática contra una fuente externa: no existe ninguna disponible |

**Qué es y qué no es `REGISTRATION_TOKEN`.** Es el control de *quién puede registrar instituciones*, y nada más:

- ✅ **Sirve para:** limitar el alta de entidades a quien el operador le haya entregado el token.
- ❌ **No es identidad institucional:** es **un solo secreto global**, igual para todas las entidades. No dice *quién* registra. La identidad institucional la da la credencial de la entidad (sección 12), no este token.
- ❌ **No es verificación:** que alguien tenga el token no prueba que la entidad exista ni que sea quien dice. La verificación es una decisión humana aparte y explícita (ADR-07).
- ⚠️ **Debe estar configurado en cualquier ambiente desplegado.** Hoy es opcional y, vacío, el registro queda abierto (el arranque lo avisa). Sin él, cualquiera puede llenar el directorio de entidades; la verificación evita que esas entidades operen, pero no que se registren. *Su comportamiento funcional no se cambió en ADR-07: esto es una recomendación de despliegue pendiente de aplicar por el equipo.*

**Otras decisiones.** La entidad y su carpeta son un solo documento (una escritura atómica: no hay entidad sin carpeta ni al revés). Cuerpo acotado a 16 KB (`413`), solo `application/json` (`415`), JSON mal formado `400`, entradas que no son objeto `400` (nunca `500`). Los campos de texto se limpian de saltos de línea y caracteres de control, y el correo de contacto rechaza saltos de línea y varios destinatarios. Los logs no contienen nombre, correo ni NIT de la entidad. Los índices únicos se construyen **antes** de aceptar registros.

## 11. Reconciliación de eventos y registros pendientes

Cuatro mecanismos que cierran huecos hallados en la prueba integral (todos con pruebas y mutaciones):

- **Publicador que se recupera.** `EventPublisher` (`ms-identidad` y `ms-documentos`) guardaba el canal para siempre: si RabbitMQ se reiniciaba, **toda** publicación fallaba hasta reiniciar el servicio. Ahora olvida el canal al cerrarse, reconecta en la siguiente publicación, comparte una sola apertura entre publicaciones simultáneas y escucha el evento `error` (sin oyente, amqplib tumba el proceso). Además `ms-identidad` ya no espera al broker más de `EVENT_PUBLISH_TIMEOUT_MS` (3 s) al publicar `ciudadano.registrado`: con RabbitMQ apagado el registro tardaba más que el gateway (504 de un registro que sí quedaba hecho); ahora responde `201` (~8 s en la prueba, con las llamadas a GovCarpeta incluidas) y el evento queda pendiente.
- **Reenvío de `documento.cargado`** (`EventReconciler`, `ms-documentos`). Cada `RECONCILE_INTERVAL_MS` (60 s) reenvía los documentos con `eventoPublicado:false` de al menos `RECONCILE_MIN_AGE_MS` (60 s: uno recién cargado puede tener su publicación en curso). El `eventId` ahora es el id del documento (antes aleatorio): un reenvío es **el mismo evento** y `ms-notificaciones` envía un solo correo. Es seguro con varias réplicas.
- **Registros pendientes y `ciudadano.registrado`** (`PendingRegistrationReconciler`, `ms-identidad`). Un pendiente de al menos 5 min se resuelve preguntando a GovCarpeta (`validateCitizen`): *disponible* → se descarta y el documento vuelve a poder registrarse; *afiliado* → se activa y se publica el evento; *sin respuesta* → se reintenta después. Las transiciones son condicionales (solo si sigue `pendiente`), así que dos réplicas o una saga tardía no chocan. También reenvía `ciudadano.registrado` de los ciudadanos con `eventoPublicado:false`; los anteriores a ese campo no se reenvían.
- **Consumidor de `ciudadano.registrado` en `ms-documentos`** (HU-01, paso 7): crea la carpeta, idempotente, con reintento con retroceso y cola `.fallidos` para mensajes inválidos.

Ambos procesos se desactivan con `RECONCILE_INTERVAL_MS=0`. Cada resolución queda en la bitácora (`reconciliado…`) y en los logs (`saga.reconciliacion`, `documento.reconciliacion`).

## Límites (qué NO cubre)

- **Sin gestor de secretos** dedicado ni rotación automática de secretos: es rotación asistida por configuración.
- **mTLS/TLS interno no está activado** en ningún despliegue; solo está implementado y probado.
- **Solo `ms-identidad`**: el criterio "credenciales por servicio" y el tráfico entre servicios reales no se pueden demostrar hasta que existan otros servicios.
- El escáner detecta patrones comunes, no todo secreto posible; no sustituye una revisión ni un escáner de historial de git.
- Las URLs prefirmadas están solo como política de configuración, sin uso todavía.
- **Llave simétrica compartida (HS256):** todo servicio que verifica tokens conoce la llave que también firma. Un servicio comprometido podría emitir tokens. Pasar a llaves asimétricas (RS256/ES256, con clave pública en cada servicio) es la mejora natural; queda fuera de esta entrega.
- **Sin cierre de sesión ni revocación del access token:** un access token robado vale hasta 15 minutos. Se revocan los refresh tokens solo ante reutilización; no hay `logout` (no está en la HU).
- **El bloqueo es por cuenta, no por origen:** un atacante que conozca un documento puede bloquear esa cuenta 15 minutos con 5 intentos (denegación temporal). No hay limitación por IP: correspondería al gateway.
- **Registro (HU-01):** la reconciliación de pendientes **asume** que un ciudadano que GovCarpeta ya da por afiliado, tras un intento nuestro dudoso, lo afilió nuestra llamada (la saga comprobó antes que estaba disponible); si otro operador lo afilió justo en medio, se activaría uno que no es nuestro, y GovCarpeta no ofrece cómo distinguirlo. Un pendiente reciente (menos de `RECONCILE_MIN_AGE_MS`, 5 min por defecto) responde `409` hasta que se reconcilie. `ms-documentos` crea la carpeta al recibir `ciudadano.registrado` pero **no guarda todavía la cédula firmada por la Registraduría** (la Registraduría está simulada).
- **Documentos (HU-03):** no hay análisis antivirus ni de contenido del PDF (solo tipo, firma y tamaño); el cifrado en reposo lo da el proveedor de storage, no el servicio; si el broker falla, el evento queda `eventoPublicado:false` y se reenvía solo (sección 11), con un retraso de hasta `RECONCILE_INTERVAL_MS` + `RECONCILE_MIN_AGE_MS` (2 min por defecto); un `504` del gateway con una carga ya terminada por el servicio sigue siendo posible en un caso límite (el servicio se rinde antes, por configuración, pero no está garantizado por construcción); la carga certificada por una entidad emisora (HU-10) y la eliminación de documentos (que devolvería cupo) no están implementadas.
- **Consulta de documentos (HU-08):** el total y la página se leen con dos consultas separadas (no son un instante único: una carga concurrente puede hacer que `total` y la página difieran en uno); la paginación es por desplazamiento, por lo que con cargas simultáneas un documento puede aparecer en dos páginas o saltarse; no hay filtros ni búsqueda; la consulta de un ciudadano propio no se registra en la bitácora (solo los intentos rechazados).
- **Notificaciones (HU-03):** el contador de intentos por mensaje vive en memoria (si el proceso reinicia, la cuenta vuelve a empezar; solo alarga el reintento); un aviso enviado cuyo registro `enviado` no se pudo guardar y cuyo reclamo se vuelve "abandonado" podría reenviarse una vez pasado `NOTIFICATION_STALE_CLAIM_MS` (correo duplicado, nunca perdido); solo correo (no hay SMS ni bandeja del portal); no hay reproceso automático de la cola de fallidos (es manual); la bienvenida solo se envía para ciudadanos registrados con el evento ya enriquecido (los eventos antiguos, sin correo, van a fallidos); el `ciudadano.registrado` lleva nombre y correo por el broker interno (TLS fuera de local).
- **Directorio de operadores (HU-05a):** la validación de la dirección es sobre su **texto**: no se resuelve el DNS, así que un nombre público que resuelva a una IP privada (*DNS rebinding*) no se detecta aquí; quien haga la llamada real de transferencia (HU-05c) debe verificar la IP resuelta. No hay API HTTP del directorio (lo usan por dentro las transferencias). GovCarpeta no permite saber a qué operador pertenece un ciudadano. El límite de refrescos forzados vive en memoria por réplica (varias réplicas pueden sumar más llamadas al sandbox).
- **Instituciones (HU-06.1):** el registro es **autodeclarado** y, sin `REGISTRATION_TOKEN`, abierto (ver sección 10): no hay verificación de que la entidad exista ni sea quien dice; **no hay limitación de tasa** (un actor puede crear muchas entidades con NIT válidos distintos: el NIT se valida por su dígito, no contra el RUES/DIAN); no hay API para consultar, editar ni dar de baja una institución (solo el registro y la consulta interna `hasInstitutionalFolder`).
- **`ms-gateway` es mínimo:** valida tokens, enruta por lista blanca, propaga el trace-id y expone TLS/mTLS opcional, pero no hace limitación de tasa (por IP o por cliente), no tiene circuit breaker ni balanceo entre réplicas de un mismo servicio, y sus rutas están en código (`src/routes.js`), no en una configuración dinámica. Como se dijo arriba, la limitación por origen (el bloqueo de cuentas por IP) le correspondería.

## 12. Autenticación institucional (`ms-comparticion`, ADR-07)

**La autenticación de ciudadanos pertenece a `ms-identidad`; la de instituciones, a `ms-comparticion`. Cada tipo de actor usa un JWT independiente y un secreto criptográfico independiente.** Decisión completa, alternativas descartadas y consecuencias: [`ADR-07`](ADR-07-AUTENTICACION-INSTITUCIONAL.md).

`POST /api/v1/institutions/auth/token` recibe `{nit, password}` y responde `200 {accessToken, tokenType: "Bearer", expiresIn: 900}` (con `Cache-Control: no-store`). Es pública en el gateway por la misma razón que el login del ciudadano: no se puede exigir un token para pedir un token.

| Aspecto | Ciudadano (HU-02) | Entidad (ADR-07) |
|---|---|---|
| Emisor / `iss` | `ms-identidad` | `ms-comparticion` |
| Llave de firma | `JWT_SECRET` | **`ENTITY_JWT_SECRET`** |
| Credencial | documento + contraseña | NIT + contraseña |
| Claims propios | `typ`, `jti`, (`fam` en refresh) | `typ`, `act: "entidad"`, `jti`, `ver` |
| `sub` | `ciudadanoId` | `institutionId` |
| Vigencia | 15 min + refresh de 7 d | 15 min, **sin refresh** |
| Middleware | `requireAuth` → `req.auth.ciudadanoId` | `requireEntityAuth` → `req.auth.institutionId` |

**Por qué un token no puede pasar por el otro.** Un token institucional presentado a `requireAuth` falla dos veces, de forma independiente: su `kid` no está en el llavero de ciudadanos (la llave es otra) y su `iss` no es `ms-identidad`. Al revés, `requireEntityAuth` exige `iss: ms-comparticion` **y** `act: "entidad"` **y** que la firma valide con el llavero institucional. Probado en los dos sentidos, incluso con un token que imita todos los claims pero está firmado con la llave equivocada.

`requireEntityAuth` deja `req.auth = {institutionId, tokenId, actorType: "entidad", verificada}` y **nunca** `ciudadanoId`: como `requireOwner` (en `ms-documentos`) compara contra `ciudadanoId`, un token institucional no puede pasar por dueño de una carpeta ni por accidente — el campo simplemente no existe.

**Las dos llaves deben ser distintas.** El validador de configuración del gateway y el de `ms-documentos` **rechazan arrancar** si `ENTITY_JWT_SECRET` es igual a `JWT_SECRET`, en cualquier ambiente. Si fueran la misma, toda la separación sería decorativa. Rotación: el mismo procedimiento de tres fases de la sección 3, con `ENTITY_JWT_SECRET_PREVIOUS`.

| Servicio | Qué hace con la llave institucional |
|---|---|
| `ms-comparticion` | **Firma.** Obligatoria fuera de `development`/`test`: el servicio no arranca sin ella |
| `ms-gateway` | **Verifica.** Opcional hoy (ninguna ruta `actor: "entidad"` declarada); sin ella esas rutas responden `401` |
| `ms-documentos` | **Verificará** (HU-10). Opcional; `requireEntityAuth` existe pero ninguna ruta lo monta todavía |
| `ms-identidad` | **No la conoce.** No firma ni verifica tokens institucionales |

**Credencial y fuerza bruta.** Argon2id (ADR-06), nunca en claro; un resumen de otra variante (`argon2i`/`argon2d`) no autentica. Todo rechazo devuelve el mismo `401 {"error":"credenciales invalidas"}`, sin distinguir NIT inexistente, contraseña incorrecta, entidad sin credencial o entidad bloqueada; si el NIT no existe se verifica igual contra un resumen descartable, para que la respuesta tarde lo mismo. Al 5.º intento fallido la entidad se bloquea 15 minutos (atómico, y durante el bloqueo no se cuentan más intentos). Cada intento queda en `audit_logs` como `institucion.autenticar` con `actorType: "entidad"` y su `traceId`; como actor y `resourceOwner` coinciden (la entidad actúa sobre sus propias credenciales), no cuenta como acceso fuera de política (RNF-07).

## 12.1 Verificación institucional (ADR-07)

> **La autenticación institucional y la verificación institucional son conceptos independientes. Una institución no verificada puede autenticarse, pero no puede ejecutar operaciones institucionales sensibles.**

> **La verificación institucional representa una decisión humana registrada por el operador del sistema. No constituye una verificación automática de existencia jurídica contra una fuente externa.**

No hay fuente externa que consultar: GovCarpeta solo conoce ciudadanos y operadores, el RUES/DIAN está fuera del alcance, y el dígito de verificación del NIT es aritmética, no existencia. Lo que el sistema garantiza es **trazabilidad de la decisión**, no la verdad del mundo real.

**Cómo se verifica.** Operación administrativa **fuera de banda**, con el mismo patrón que HU-11 y HU-05b (simulación por defecto, `--confirm` para actuar, códigos de salida):

```bash
cd services/ms-comparticion
npm run verify:institution -- --nit=890901389                                    # simula: muestra qué quedaría escrito
npm run verify:institution -- --nit=890901389 --confirm --motivo="carta membretada + correo del dominio"
npm run verify:institution -- --nit=890901389 --revoke --confirm --motivo="cese del convenio"
```

Salida: `0` ok · `1` error · `2` datos inválidos / uso / la entidad no existe · `3` ya estaba en ese estado (no se escribió nada). `--por="Nombre"` fija el responsable; si se omite se usa `VERIFICATION_DECIDED_BY` o el usuario del sistema operativo.

**Por qué un script y no una ruta HTTP.** El gateway solo enruta lo que declara su lista blanca, así que un script **no es alcanzable desde fuera por construcción**, y ejecutarlo exige acceso al despliegue: **una entidad no puede verificarse a sí misma**. Se suman las defensas que ya existían: `register()` ignora `verificada` si llega en el cuerpo (probado) y ningún token institucional autoriza esta operación.

**Qué queda registrado.** En el documento, la última decisión (`verificadaEn`, `verificadaPor`, `motivoVerificacion`); en `audit_logs`, **todas** las decisiones, append-only, como `institucion.verificar` / `institucion.revocar_verificacion` con **`actorType: "sistema"`** (el valor que el enum declaraba y nunca se había usado) y el motivo en `metadata`. El motivo es obligatorio al confirmar: es la evidencia de la revisión. La operación es **idempotente**: si la entidad ya estaba en ese estado no se escribe nada y la decisión original no se pisa.

**Dónde se exige.** En la operación, no en el login:

```
requireEntityAuth      → ¿eres una entidad?        401 si no
requireVerifiedEntity  → ¿estás VERIFICADA?        403 si no
```

Es **403 y no 401** a propósito: la credencial es válida y se reconoció a la entidad; lo que falta es autorización, y volver a autenticarse no lo arregla. El rechazo queda en la bitácora (`entidad_no_verificada`), y si la bitácora falla el rechazo **sigue siendo un rechazo**.

**Ventana de propagación, aceptada.** `requireVerifiedEntity` lee el claim `ver` del token y **no consulta a `ms-comparticion`**: una llamada síncrona acoplaría el servicio crítico al de compartición, justo lo que evita la matriz de degradación. Por eso **una revocación tarda hasta 15 minutos** en surtir efecto en `ms-documentos` (es inmediata en `ms-comparticion`, que lee su propia base). Para acortarla, la palanca es `ENTITY_ACCESS_EXPIRES_IN`.

### Lo que esta base NO resuelve todavía

- **La verificación es humana, no automática** (ver arriba): que una entidad esté verificada significa que alguien del equipo operador lo decidió y dejó constancia.
- **`REGISTRATION_TOKEN` sigue siendo opcional**: sin él, cualquiera puede *registrar* una entidad y obtener un token para ella. La verificación evita que **opere**, no que se registre. Debería exigirse en ambientes desplegados (sección 10).
- **No hay forma de asignar ni rotar la credencial** de una entidad ya registrada: la contraseña solo se fija al registrarse (es opcional), y una entidad registrada sin ella no puede autenticarse.
- **No hay revocación del token institucional**: un token robado vale hasta 15 minutos, igual que el del ciudadano.
- **No hay limitación de tasa** en el endpoint de login (el bloqueo es por entidad, no por origen), como en todo el resto del sistema.
- **La primera ruta protegida de entidad es `ms-analitica` (HU-07.2, ver 12.2)**; HU-10 y HU-06.3 traerán las siguientes. `requireVerifiedEntity` está escrito y probado en `ms-documentos`, pero **no lo monta ninguna ruta todavía**.
- **`hasInstitutionalFolder()` no mira `verificada`** y se dejó así a propósito. **Resuelto en HU-06.2** (sección 15): para recibir un paquete en su carpeta, la entidad además debe estar verificada; si no, cae al correo (RF-26).

## 12.2 Casos PQRS y autorización Premium (`ms-analitica`, HU-07.2)

> **Institución autenticada ≠ institución Premium.** `/api/v1/cases` exige hoy un token institucional válido (ADR-07, sección 12) y nada más. No existe todavía ningún control de que la institución tenga contratado el servicio Premium que HU-07 describe ("como servicio Premium cobrable del operador").

`requireEntityAuth` verifica identidad (firma, emisor, `act: "entidad"`, expiración) exactamente igual que en cualquier otra ruta institucional; `PqrsCaseService` no consulta ningún atributo de plan antes de crear o modificar un caso. En la práctica, **cualquier institución registrada en `ms-comparticion` puede usar HU-07.2**, esté o no pagando por Premium.

**Esto es deliberado, no un olvido.** El mecanismo de autorización Premium (qué instituciones lo tienen, dónde vive ese dato, cómo se revoca) es una decisión de diseño pendiente — se evaluaron tres alternativas (claim en el JWT institucional, consulta síncrona a `ms-comparticion` en cada petición, y un atributo replicado vía evento con proyección local en `ms-analitica`) y ninguna se implementó a propósito, para no comprometerse con un mecanismo antes de que el curso lo exija con más detalle (facturación, planes, vigencia).

Mientras esa decisión no se tome:

- **No se agrega `premium` al JWT institucional** (ni al de `ms-comparticion` al firmar, ni a lo que `requireEntityAuth` espera al verificar).
- **No se agrega ningún campo `premium`/`plan` a `Institution`** (`ms-comparticion` sigue siendo la única dueña de ese modelo, ADR-01).
- **No existe ningún mecanismo alternativo** (tabla propia en `ms-analitica`, variable de entorno, lista blanca) que simule Premium mientras tanto: sería un sistema paralelo que habría que desmontar después.

**Consecuencia práctica.** HU-07.2 está funcionalmente completa (creación, consulta, listado y cambio de estado de casos PQRS, con ownership institucional correcto) pero **no cumple todavía** la restricción de negocio "servicio Premium cobrable" de HU-07. Se documenta aquí para que quede explícito en la entrega, y no se descubra al revisar el código.

## 12.3 Solicitud documental multioperador (`ms-analitica`, HU-07.3) — implementación parcial

> HU-07.3 se implementa parcialmente mediante el registro local de solicitudes documentales. La identificación automática del operador actual del ciudadano, el envío interinstitucional, el consentimiento del ciudadano y la transferencia/entrega documental quedan pendientes de HU-05c y HU-06.3.

Antes de implementar este paso se hizo una inspección explícita del código de `ms-interoperabilidad`, `ms-documentos` y `ms-comparticion` (no una suposición): `ms-interoperabilidad` no expone hoy ningún endpoint de negocio (solo `/health`/`/ready`); `OperatorDirectoryService` únicamente resuelve un operador ya conocido por `operatorId`/`name`, nunca "a qué operador pertenece este ciudadano"; y tanto `HU-05c` como `HU-06.3` están **especificadas en `docs/HISTORIAS_DE_USUARIO.md` pero sin una sola línea de código** (`TransferSagaService`/`TransferConfirmService` no existen en ningún archivo del repositorio; solo se nombran en ese documento de planificación).

`POST /api/v1/premium/document-requests` crea un `DocumentRequest`: `institutionId` (del token, ADR-07, igual que en HU-07.2), `direccionUnica` (validada solo por FORMA, mismo patrón y misma expresión regular que `InboundDocumentService` usa para el `destinatario` de HU-10), `descripcion` y `operadorDestinoId` opcional. El único estado posible es `registrada`.

**Por qué `/premium` en el path**: para no colisionar con el agregado `Solicitud` de HU-06.3 (diseñado, no implementado todavía, propuesto en `ms-documentos`), que es un flujo distinto — intra-operador, con consentimiento real del ciudadano — que originalmente iba a compartir el mismo path `/api/v1/document-requests` en un servicio diferente. Son conceptos distintos (ver comparación en el diseño de HU-06.3); el prefijo además deja explícito que esta ruta es funcionalidad Premium, a diferencia de la de HU-06.3.

Explícitamente, en esta versión:

- **`operadorDestinoId` solo puede registrarse si la institución solicitante YA LO CONOCE de antemano** (por fuera del sistema); es un dato de texto libre con formato validado, no una referencia verificada.
- **No se valida `operadorDestinoId` contra `ms-interoperabilidad`**: ese servicio no expone ningún endpoint de negocio para eso hoy (ver inspección arriba). Validarlo habría exigido crear ese endpoint, fuera del alcance de este paso.
- **No existe descubrimiento automático del operador de un ciudadano.** No es una limitación de esta implementación: es una limitación del ecosistema completo — GovCarpeta nunca expuso esa capacidad (mismo hallazgo ya documentado para HU-05a).
- **No existe todavía ningún protocolo de transferencia, envío interinstitucional, ni consentimiento del ciudadano.** `DocumentRequestService` no hace ninguna llamada HTTP saliente ni publica ningún evento RabbitMQ: es exclusivamente un registro local.

**Consecuencia práctica.** `POST/GET /api/v1/premium/document-requests` están funcionalmente completos como *registro* (con el mismo aislamiento institucional que HU-07.1/07.2: la institución sale siempre del token, nunca del cuerpo, y una solicitud ajena responde `404`, no `403`, mismo criterio que `PqrsCase`). Lo que HU-07.3 describe como historia completa — "solicitar documentos a clientes sin importar en qué operador estén afiliados" — **no está implementado ni parcialmente simulado**: no hay ningún camino, ni siquiera de prueba, que llegue a otro operador o a un ciudadano real. Se documenta aquí para que quede explícito en la entrega, y no se confunda un registro local con una solicitud multioperador funcional.

## 13. Autenticación de documentos en GovCarpeta (`ms-autenticacion`, HU-04)

El ciudadano pide certificar un documento propio; el operador se lo pide al centralizador sin que el ciudadano espere
(RNF-10) y sin entregarle nunca el archivo (RNF-13, RNF-14).

```
ciudadano --PUT /api/v1/documents/:id/authenticate--> ms-documentos   (202; temporal -> en autenticacion)
ms-documentos --documento.autenticacion_solicitada--> ms-autenticacion
ms-autenticacion: URL prefirmada 15 min -> PUT /apis/authenticateDocument (hasta 3 intentos)
ms-autenticacion --documento.autenticado | documento.autenticacion_fallida--> ms-documentos, ms-notificaciones
ms-documentos: en autenticacion -> certificado (+ fechaAutenticacion, libera cupo) | temporal
```

**Solicitud (`ms-documentos`).** Orden de las barreras: token de ciudadano revalidado aquí → el documento existe
(`404`, también para un id mal formado) → es del ciudadano del token (`403` y bitácora `documento.autenticar` /
`no_es_dueno`; `requireOwner` no sirve porque `:id` es el documento, no la carpeta) → la carpeta tiene la cédula
(`409`, sin tocar el estado) → `temporal` → `en autenticacion` en **una escritura condicional** (`400` si no estaba
`temporal`; dos solicitudes simultáneas: una `202` y otra `400`). La respuesta no expone la clave del storage ni la
cédula.

| Aspecto | Decisión |
|---|---|
| Cédula (`idCitizen`) | Copia local en la carpeta, desde `ciudadano.registrado` (ya la traía). No va en el token ni se pide al ciudadano. Una carpeta creada por una carga antes del evento no la tiene: responde `409` y se puede reintentar cuando llegue |
| Intentos | Cada solicitud incrementa `autenticacionIntento`. El `eventId` es `<documentoId>-auth-<n>`: un reenvío del mismo intento es el mismo evento; pedir de nuevo tras un fallo no se confunde con un duplicado |
| Resultado | Se aplica solo si el documento sigue `en autenticacion` **en ese intento**: un resultado repetido o atrasado no hace nada, y el cupo se libera una sola vez |
| Cuota | `en autenticacion` sigue siendo no certificado y conserva su cupo; al certificarse se libera (RNF-04); si falla, lo conserva |
| Broker caído al pedir | La solicitud no falla (ADR-04): queda `autenticacionEventoPublicado:false` y la reenvía `AuthenticationRequestReconciler` |
| `ms-autenticacion` caído | La cola `ms-autenticacion.autenticacion-solicitada` la predeclara `ms-documentos`: las solicitudes esperan y se procesan al volver (matriz de degradación) |

**Procesamiento (`ms-autenticacion`).**

| Aspecto | Decisión |
|---|---|
| URL prefirmada | De **lectura**, vigencia **exacta** de `PRESIGNED_URL_AUTH_TTL_SECONDS` (900 s por defecto; el arranque rechaza más de 900). Se firma para `S3_PUBLIC_ENDPOINT` (el host que GovCarpeta abre). Solo se firman claves `ciudadanos/<ciudadanoId>/<uuid>.pdf` **del mismo ciudadano del evento**: aunque alguien publicara en el bus, no obtiene una URL de otro objeto |
| Llamada | `{idCitizen: number, UrlDocument, documentTitle}` (U mayúscula), nunca el binario; respuesta tratada como texto plano; `x-trace-id` propagado |
| Reintentos | `500` o sin respuesta → hasta **3** intentos con espera creciente (1 s, 2 s). `204`/`501`/otros → definitivo, sin reintentar. Solo `200` certifica |
| Resultado | `documento.autenticado` o `documento.autenticacion_fallida` (`motivo`: `rechazado` \| `no_disponible`). Si GovCarpeta no respondió tras los 3 intentos, **además** el mensaje original va a `ms-autenticacion.autenticacion-solicitada.fallidos` (evidencia de la caída del centralizador); un rechazo definitivo es un resultado procesado y se confirma normal |
| Idempotencia | `AuthenticationAttempt` con índice único por `eventId` y reclamo atómico: una reentrega no vuelve a llamar a GovCarpeta (8 entregas simultáneas → 1 llamada); si el resultado no se alcanzó a publicar, se republica **el mismo**. Un fallo propio antes de llamar (p. ej. no se pudo firmar) libera el reclamo para que la reentrega lo retome; un reclamo abandonado se retoma tras 5 min |
| Bitácora | `documento.autenticar_govcarpeta`, `actorType: "sistema"`, `resourceOwner` = ciudadano, `delegated: true` (actúa porque el ciudadano lo pidió), con el número de llamadas |
| Datos personales | Ni la cédula, ni el título, ni la URL firmada (es una credencial temporal) aparecen en logs, en la base de este servicio ni en el evento de resultado |
| Configuración | Mismas reglas que el resto fuera de local (TLS en Mongo/RabbitMQ, `https` en S3, en el host público y en GovCarpeta, sin credenciales de tutorial). `GOVCARPETA_MAX_ATTEMPTS` no puede superar 3 |

**Límites conocidos.**

- **No se probó contra el sandbox real.** GovCarpeta tiene que *descargar* el documento por la URL; con MinIO en
  `localhost` no llega. Hace falta un storage público (S3 u otro) para una prueba real; el `PUT` real no se ha ejecutado.
- **Evidencia limitada (RNF-08):** GovCarpeta solo responde un texto, no un artefacto criptográfico verificable. Se
  guarda el estado y la `fechaAutenticacion` (supuesto ya declarado en el expediente, 9.4).
- **Credenciales de storage:** `ms-autenticacion` usa las mismas del bucket de `ms-documentos`; en despliegue deberían
  ser de solo lectura.
- **Cupo al certificar:** pasar a `certificado` y liberar el cupo son dos escrituras; si el proceso muere entre ambas,
  el ciudadano queda con un cupo ocupado de más (nunca de menos).
- **Sin límite de solicitudes:** un ciudadano puede reintentar un documento rechazado cuantas veces quiera (cada una es
  una llamada al centralizador); no hay limitación de tasa en el sistema.
- **La URL entregada no se puede revocar** antes de sus 15 minutos (propiedad de las URLs prefirmadas).

## 14. Transferencia de ciudadanos entre operadores (`ms-interoperabilidad`, HU-05c)

Protocolo acordado entre los equipos del curso (dos fases con confirmación). GovCarpeta solo interviene para
desafiliar/afiliar y para el directorio; los documentos viajan **directo entre operadores** (RNF-13, RNF-14).

| Endpoint (lo expone cada operador) | Cuerpo |
|---|---|
| `POST /api/transferCitizen` | `{id, citizenName, citizenEmail, urlDocuments: {URL1: [url], ...}, confirmAPI}` |
| `POST /api/transferCitizenConfirm` | `{id, req_status}` con `req_status` `1` (éxito) o `0` (fracaso) |

**Extensiones opcionales que enviamos** (un receptor que no las conozca las ignora; al recibir, se toleran ausentes):
`direccionUnica` (RF-10), `citizenAddress` (GovCarpeta exige una dirección para afiliar) y `metadata` por clave de
`urlDocuments` (`titulo`, `entidadAvaladora`, `fecha`, `estado`, `sha256`). Nota: el Gherkin del issue #53 dice
`req_status: "completado"`; el protocolo acordado entre equipos es `1`/`0` y es el que se implementa.

### Origen (el ciudadano se va)

```
ciudadano -POST /api/v1/transfers {operadorDestinoId}-> ms-interoperabilidad (202)
  -> transferencia.exportar_carpeta -> ms-documentos: carpeta en SOLO LECTURA + URL prefirmada y metadatos por documento
  -> unregisterCitizen (GovCarpeta, una vez) -> POST transferCitizen al destino -> esperar confirmacion
  <- transferCitizenConfirm 1 -> ciudadano.transferido -> ms-documentos borra objetos/documentos/carpeta; ms-identidad
                                  revoca sesiones y borra al ciudadano (RF-08)
  <- 0, 5 min sin respuesta x3 envios, o rechazo definitivo -> compensar: registerCitizen (si ya se habia desafiliado)
                                  + transferencia.cancelada (desbloquea la carpeta)
```

| Aspecto | Decisión |
|---|---|
| Destino | Se resuelve con el directorio en modo **estricto** (HU-05a): nunca una copia vieja, nunca nuestro propio operador |
| Solo lectura | Mientras dura, la carpeta no admite cargas (HU-03), entregas institucionales (HU-10), autenticaciones (HU-04) ni solicitudes (HU-06.3): `409`. La consulta sigue funcionando. La reserva de cupo lo revalida de forma atómica |
| Datos del ciudadano | Copia local en `ms-interoperabilidad` desde `ciudadano.registrado` (que ahora lleva también `direccion`): no hay llamadas síncronas entre servicios (ADR-01) |
| **Confirmación** | El protocolo no autentica al operador que llama: cualquiera que conozca una cédula podría confirmar y hacernos **borrar** al ciudadano. Por eso nuestro `confirmAPI` lleva un **token aleatorio por transferencia** (`?t=...`); una confirmación sin él (o con otro) responde `404` y no borra nada. Compatible con el protocolo: el destino llama la URL tal cual la recibió |
| Borrado | Solo tras `req_status: 1`, y primero se publica `ciudadano.transferido` (si el broker no confirma se responde error y el destino reintenta). Repetir la confirmación responde igual sin volver a borrar |
| Plazos | `TransferSweeper` (cada 30 s) reenvía a los 5 min sin confirmación, hasta 3 envíos; repite órdenes internas sin respuesta; termina compensaciones que quedaron a medias (`fallando`) |
| Estado en `ms-identidad` | Se **borra** el registro (no se deja `transferido`): el protocolo pide borrar y así, si el ciudadano regresa, se puede importar de nuevo con la misma dirección única (índice único) |

### Destino (el ciudadano llega)

```
otro operador -POST /api/transferCitizen-> ms-interoperabilidad (202)
  -> transferencia.importar_documentos -> ms-documentos descarga, valida y guarda en NUESTRO storage (todo o nada)
  -> transferencia.registrar_ciudadano -> ms-identidad crea al ciudadano (misma direccion unica), registerCitizen con
                                           NUESTRO operador, publica ciudadano.registrado (carpeta + bienvenida)
  -> POST confirmAPI del origen {id, req_status: 1}      (si algo falla: revertir lo importado y req_status: 0)
```

| Aspecto | Decisión |
|---|---|
| URLs de un tercero | `confirmAPI` y cada URL de documento pasan la política de HU-05a (http/https, sin credenciales, sin hosts o IPs locales/privadas, sin `file:`); además la **IP resuelta** se valida al conectar (DNS rebinding, pendiente desde HU-05a), sin redirecciones, con plazo y tamaño máximo |
| Documentos | Se aceptan PDF, PNG y JPEG por su **firma real**; si el origen declara `sha256`, debe coincidir. Todo o nada: si uno falla, se deshace lo importado y se confirma `0` (el origen no borra nada). Un 5xx del origen se reintenta. Idempotente por (transferencia, clave) |
| Estado del documento | El que declare el origen en `metadata` (`certificado`/`temporal`); sin metadato, `temporal`. Los temporales ocupan cupo aunque superen el máximo (no se pierde nada al llegar). Un escaneo (imagen) no se puede autenticar después (HU-04 solo firma PDF) |
| Reintentos del origen | Un pedido idéntico devuelve la misma transferencia; otro pedido para la misma cédula en curso, o una cédula que ya es nuestra: `409` |
| Registro | Igual de cuidadoso que HU-01: `pendiente` antes de GovCarpeta, sin reintento ciego de `registerCitizen`, un resultado ambiguo se resuelve con `validateCitizen` |

### Límites conocidos

- **El ciudadano que llega no puede iniciar sesión**: la contraseña no viaja entre operadores y no existe un flujo
  para fijarla (activación o recuperación de cuenta no está en ninguna HU). Queda activo, con su carpeta y su correo de
  bienvenida; el login lo rechaza con el mismo `401` genérico.
- **RF-10 depende del origen**: si el otro operador no envía `direccionUnica` (extensión opcional), se le genera una
  nueva y queda constancia en el log.
- **Compensación incompleta posible**: si el destino alcanzó a afiliar al ciudadano pero su confirmación nunca nos
  llegó, al compensar `registerCitizen` responde `501`; la transferencia queda `fallida` con el motivo
  `reafiliacion_fallida_501` para revisión manual. GovCarpeta no permite distinguir el caso automáticamente.
- **Estado de los documentos**: un documento `en autenticacion` viaja como `temporal`; el `certificado` que declara el
  otro operador se acepta sin re-verificar (GovCarpeta no ofrece un artefacto verificable, ver 9.4 del expediente).
- **URLs exportadas**: vigencia de 1 h (tope de `PRESIGNED_URL_DOWNLOAD_TTL_SECONDS`); alcanza para los 3 envíos de
  5 minutos. No se pueden revocar antes de vencer.
- **Sin aviso al ciudadano que se va** del resultado de su transferencia (solo el que llega recibe la bienvenida).
- No se probó contra otro operador real del curso: la suite de contrato es HT-05.

### 14.1 Pruebas de contrato del protocolo (HT-05, RNF-11)

El contrato vive como validadores en `services/ms-interoperabilidad/src/contract/protocol.js`: la suite, el operador de
referencia y las pruebas de nuestra implementación usan exactamente las mismas reglas.

`ContractTestSuite` se corre contra la URL base de **cualquier** operador. Hace de origen: sirve dos PDF de prueba,
envía un `transferCitizen` válido y espera la confirmación en un `confirmAPI` propio.

| Caso | Tipo |
|---|---|
| `transferCitizen` acepta un pedido válido (2xx) | obligatorio |
| confirma en el `confirmAPI` recibido, dentro del plazo | obligatorio |
| usa exactamente esa URL (con su consulta: ahí va nuestro token) | obligatorio |
| la confirmación cumple `{id: number, req_status: 1\|0}` y el `id` es el del ciudadano | obligatorio |
| un pedido válido se completa con `req_status: 1` | obligatorio |
| descarga los documentos directamente de nosotros | obligatorio |
| rechaza un `transferCitizen` mal formado (4xx) | recomendado |
| expone `transferCitizenConfirm` (no 404/405 ni 5xx) | recomendado |

Un operador **cumple** si pasa el 100% de los obligatorios (RNF-11); los recomendados se reportan como aviso.

```bash
cd services/ms-interoperabilidad
npm run test:contract -- --reference                                   # demostracion contra el operador de referencia
npm run test:contract -- --target=https://otro.example.co --callback=https://mi-tunel.example.co --port=4010
```

Contra otro equipo, `--callback` debe ser una URL **pública** que llegue al `--port` local (p. ej. un túnel): el otro
operador descarga los documentos de prueba y confirma ahí. Salida: `0` cumple, `1` no cumple, `2` uso inválido.

**En CI** (`npm test`) la suite corre contra el operador de referencia (debe cumplir el 100%), contra operadores que
**no** cumplen (`req_status: "completado"` —el formato viejo del issue #53—, `id` como texto, sin confirmar, 500) para
probar que se detectan con el caso y el motivo, y contra **nuestra propia implementación** de destino (HU-05c, con
ms-documentos y ms-identidad simulados). También se valida que el `transferCitizen` que enviamos como origen cumple.

**Límites:** no se ha corrido contra un operador real de otro equipo (requiere coordinarlo y exponer `--callback`); un
operador real podría registrar en GovCarpeta al ciudadano de prueba, por lo que conviene acordar la prueba con el
otro equipo antes de lanzarla.

## 15. Paquetes documentales (`ms-comparticion` + `ms-documentos`, HU-06.2)

El ciudadano elige documentos de su carpeta y los envía juntos a una entidad (RF-24). El paquete guarda solo
**referencias** a los documentos: no se copia ningún archivo.

```
ciudadano -POST /api/v1/packages {documentoIds, destinatario: {nit?, correo?, nombre?}}-> ms-comparticion (202)
  -> paquete.creado -> ms-documentos: TODOS los documentos existen y son del ciudadano? (si no, se rechaza entero)
       canal carpeta_institucional -> permiso de lectura (PackageGrant) para la entidad (RF-25)
       canal correo                -> URL temporal por documento -> paquete.envio_correo -> ms-notificaciones (RF-26)
  <- paquete.procesado -> ms-comparticion: entregado (con metadatos) | rechazado
entidad -GET /api/v1/institutions/me/packages-> ms-comparticion        (sus paquetes entregados)
entidad -GET /api/v1/packages/:p/documents/:d/download-> ms-documentos (URL de 15 min)
```

| Aspecto | Decisión |
|---|---|
| **Canal** | Carpeta institucional **solo si la entidad está registrada, VERIFICADA (ADR-07) y con carpeta activa**: una entidad autodeclarada no recibe documentos de ciudadanos en su carpeta. En otro caso, correo: al de contacto de la entidad registrada, o al que indique el ciudadano si no está afiliada (sin correo: `400`). Así se cierra la decisión pendiente que dejó ADR-07 sobre `hasInstitutionalFolder()` (esa función sigue sin mirar `verificada`; la regla vive en `InstitutionService.resolveDeliveryTarget()`) |
| Tope | `MAX_DOCUMENTOS_PAQUETE` (20 por defecto, 1 a 100); ids repetidos se unifican |
| Propiedad | La comprueba `ms-documentos`, dueño de los documentos: un documento inexistente o ajeno rechaza el paquete **entero**, con el mismo motivo en ambos casos (no se revela qué tiene otro ciudadano) |
| Acceso de la entidad | Token institucional **y** entidad verificada (`403`) en ambas rutas. La lista se lee de la base de `ms-comparticion`, así que revocar la verificación surte efecto de inmediato; la descarga lee el claim `ver` (ventana de hasta 15 min, igual que HU-10). Solo se descarga lo que el permiso enumera y si el documento **sigue siendo** del ciudadano (`404` en todo otro caso). URL de 15 min, `no-store`, bitácora `documento.descargar` delegada |
| Correo | Un solo destinatario (se rechazan `,` y `;`, que el transporte trataría como varios). Los enlaces (1 h) van solo en el cuerpo: nunca en el asunto (se guarda en Mongo) ni en los logs. Un paquete = un correo aunque el evento se reentregue |
| Consistencia | `paquete.creado` con reconciliador si el broker no confirma; el resultado se aplica una sola vez; el permiso es único por paquete |
| Bitácora | `paquete.crear` (ciudadano), `documento.compartir` y `paquete.entregar` (sistema, delegados), `documento.descargar` (entidad, delegada) |

**Límites conocidos.**

- **No hay revocación**: una vez entregado, el ciudadano no puede retirar el paquete (no está en la HU). El acceso se
  corta solo si el documento deja de ser suyo (p. ej. se transfiere a otro operador).
- **Enlaces del correo**: vencen en 1 hora (tope de ADR-06); si la entidad lo abre después, el ciudadano debe enviarlo
  de nuevo. Quien reciba el correo reenviado también puede usarlos mientras vivan.
- **Sin límite de envíos** por ciudadano ni por destinatario (no hay limitación de tasa en el sistema).
- El paquete se entrega a una entidad de **este** operador; la entrega a una entidad afiliada a **otro** operador
  (carpeta institucional ajena) no está en el protocolo acordado y cae al correo.

## 16. Solicitud del documento oficial (`ms-documentos` + `ms-comparticion`, HU-06.4)

El ciudadano que tiene un documento **temporal** (sin firma) le pide a la entidad emisora el documento oficial
(RF-31). Cuando la entidad lo entrega, el definitivo **reemplaza** al temporal.

```
ciudadano -POST /api/v1/documents/:id/request-official {nit, descripcion?}-> ms-documentos (202, "resolviendo")
  -> solicitud_oficial.creada -> ms-comparticion: a que institucion corresponde el NIT?
  <- solicitud_oficial.resuelta -> "pendiente" (institucion) | "sin_entidad" (no afiliada aqui)
entidad verificada -GET /api/v1/official-requests-> sus pendientes, con la direccion unica del ciudadano
entidad -POST /api/v1/documents/inbound (HU-10) + solicitudOficialId-> certificado; solicitud "atendida"; temporal reemplazado
```

| Aspecto | Decisión |
|---|---|
| Quién puede pedir | El dueño, sobre un documento `temporal` suyo (`403` ajeno con bitácora, `404` inexistente, `400` si no es temporal o el NIT no pasa el dígito de verificación). Una sola solicitud abierta por temporal (`409`); tampoco con la carpeta en transferencia |
| Resolver la entidad | La hace `ms-comparticion`, dueña de las entidades, por evento. **El token institucional no se modificó**: no lleva el NIT (decisión de ADR-07, cubierta por una prueba) |
| Bandeja | Solo entidades **verificadas** (`403`) y solo sus solicitudes `pendiente`. Incluye la dirección única del ciudadano, que es lo que HU-10 necesita para entregar |
| Aviso a la entidad | Al resolverse, `ms-comparticion` informa su correo de contacto y la entidad recibe un correo (`solicitud_oficial.pendiente` → ms-notificaciones) con el documento pedido y cómo atenderlo; sin enlaces. Un solo destinatario, un correo por solicitud, reenviado por el reconciliador si el broker no confirma |
| Atender | La entrega de HU-10 con `solicitudOficialId` se valida **antes** de guardar nada: la solicitud debe estar pendiente, ser de esa entidad y del mismo ciudadano destinatario (`409` si no). Reintentar el mismo envío responde `200` y cierra la solicitud si había quedado a medias |
| Reemplazo | El temporal se **borra** (archivo y metadatos) y se libera su cupo (RNF-04), solo si sigue siendo temporal y del ciudadano. Queda en la bitácora como `documento.reemplazar_temporal` (entidad, delegada) |

**Límites conocidos.**

- Una entidad **no afiliada a este operador** no recibe la solicitud (queda `sin_entidad` y el ciudadano lo ve): no
  hay canal para avisarle (la solicitud a entidades de otros operadores no está en el protocolo acordado).
- El ciudadano no puede cancelar una solicitud abierta.
- El reemplazo **borra** el temporal: si el ciudadano quería conservar ambos, no hay opción.
