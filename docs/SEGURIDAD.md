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

## Límites (qué NO cubre)

- **Sin gestor de secretos** dedicado ni rotación automática de secretos: es rotación asistida por configuración.
- **mTLS/TLS interno no está activado** en ningún despliegue; solo está implementado y probado.
- **Solo `ms-identidad`**: el criterio "credenciales por servicio" y el tráfico entre servicios reales no se pueden demostrar hasta que existan otros servicios.
- El escáner detecta patrones comunes, no todo secreto posible; no sustituye una revisión ni un escáner de historial de git.
- Las URLs prefirmadas están solo como política de configuración, sin uso todavía.
- **Llave simétrica compartida (HS256):** todo servicio que verifica tokens conoce la llave que también firma. Un servicio comprometido podría emitir tokens. Pasar a llaves asimétricas (RS256/ES256, con clave pública en cada servicio) es la mejora natural; queda fuera de esta entrega.
- **Sin cierre de sesión ni revocación del access token:** un access token robado vale hasta 15 minutos. Se revocan los refresh tokens solo ante reutilización; no hay `logout` (no está en la HU).
- **El bloqueo es por cuenta, no por origen:** un atacante que conozca un documento puede bloquear esa cuenta 15 minutos con 5 intentos (denegación temporal). No hay limitación por IP: correspondería al gateway.
- **`ms-gateway` aún no existe:** el middleware de token está listo y probado, pero la validación en el gateway se podrá probar cuando el servicio exista.
