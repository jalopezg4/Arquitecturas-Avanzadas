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

## Límites (qué NO cubre)

- **Sin gestor de secretos** dedicado ni rotación automática de secretos: es rotación asistida por configuración.
- **mTLS/TLS interno no está activado** en ningún despliegue; solo está implementado y probado.
- **Solo `ms-identidad`**: el criterio "credenciales por servicio" y el tráfico entre servicios reales no se pueden demostrar hasta que existan otros servicios.
- El escáner detecta patrones comunes, no todo secreto posible; no sustituye una revisión ni un escáner de historial de git.
- Las URLs prefirmadas están solo como política de configuración, sin uso todavía.
