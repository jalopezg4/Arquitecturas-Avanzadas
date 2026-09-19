# Seguridad: secretos, TLS y rotación (HT-07, ADR-06)

Implementado en `ms-identidad`. Cada servicio nuevo debe replicar `src/config/`, `src/security/` y `src/transport/`.

## 1. Configuración y secretos

Toda la configuración pasa por un único módulo (`src/config/env.js`) y se valida al arrancar (`ConfigValidator`). Si algo está mal, **el servicio no arranca**, lista todos los problemas a la vez y nunca imprime el valor de un secreto.

Fuera de `development`/`test` se exige:
- `JWT_SECRET` de al menos 32 caracteres, con variedad, que no sea un placeholder (`cambiar-en-produccion`, valores de ejemplo, el secreto de desarrollo). Generar con `openssl rand -hex 32`.
- `GOVCARPETA_BASE_URL` con `https://`, `RABBITMQ_URI` con `amqps://`, `MONGO_URI` con TLS (`mongodb+srv://` o `?tls=true`).
- Sin contraseñas por defecto en las URIs (`guest:guest`, `admin:admin`, ...).

> **Importante:** si `NODE_ENV` no está definido, el servicio asume `development` y es permisivo. **Todo despliegue real debe fijar `NODE_ENV=production` (o `staging`).** Es la principal forma de que esta protección no se aplique sin que nadie lo note.

**"Gestionadas de forma centralizada":** los secretos se inyectan como variables de entorno desde un único lugar (GitHub Secrets para CI, variables de la plataforma de despliegue) y el código solo los lee de `env.js`. No hay un gestor de secretos dedicado (Vault, AWS Secrets Manager); ver límites.

**Escáner de secretos:** `npm run scan:secrets` falla si encuentra credenciales en código o configuración desplegable (llaves privadas, access keys de AWS, URIs con contraseña, `password = "literal"`...). Corre en CI antes de los tests. Un valor de desarrollo documentado se marca con `secret-scan:allow`. Los hallazgos nunca muestran el valor.

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
Se firma siempre con la llave activa y se verifica con la activa **y las anteriores**, así ningún usuario pierde la sesión al rotar.

1. Generar la llave nueva.
2. Desplegar con `JWT_SECRET=<nueva>` y `JWT_SECRET_PREVIOUS=<vieja>`. (Con varias réplicas y despliegue gradual no hay caída.)
3. Esperar a que expire el token más longevo: **`JWT_REFRESH_EXPIRES_IN` (7 días por defecto)**.
4. Desplegar sin `JWT_SECRET_PREVIOUS`. Los tokens viejos dejan de valer.

Cada token lleva un `kid` (hash de la llave, no el secreto) y el algoritmo está fijado a HS256. Al arrancar se registra `jwt.llavero` con los ids de llave activa y anteriores: sirve para confirmar qué rotación está en curso.

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
