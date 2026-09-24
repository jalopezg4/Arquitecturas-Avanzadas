# Carpeta Ciudadana — Operador

Implementación del Operador de Carpeta Ciudadana. Curso: Arquitecturas Avanzadas de Software, Universidad EAFIT.

**Equipo:** Julián Giraldo Chica, Jennifer Andrea López Gómez, Tomás Echavarría Gil

## Contexto (leer en este orden)

1. [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) — resumen de la arquitectura de microservicios (fuente completa: `Arquitectura_Carpeta_Ciudadana.docx` en la carpeta del curso)
2. [`docs/HISTORIAS_DE_USUARIO.md`](docs/HISTORIAS_DE_USUARIO.md) — las 26 historias (Entrega 2 + backlog + técnicas), con AC y tests nombrados. Espejo de los [issues en GitHub](https://github.com/jalopezg4/Arquitecturas-Avanzadas/issues).
3. [`docs/GOVCARPETA_CONTRATO.md`](docs/GOVCARPETA_CONTRATO.md) — contrato real de la API de GovCarpeta (verificado contra el Swagger, no inferido)
4. [`docs/PLAN_TRABAJO.md`](docs/PLAN_TRABAJO.md) — orden de dependencias entre historias y reparto entre los 3
5. [`docs/BUENAS_PRACTICAS.md`](docs/BUENAS_PRACTICAS.md) — principios, SOLID y patrones, con ejemplos de dónde ya se usan en este código. Revisar antes de abrir un PR.
6. [`docs/ADR-07-AUTENTICACION-INSTITUCIONAL.md`](docs/ADR-07-AUTENTICACION-INSTITUCIONAL.md) — por qué la autenticación de instituciones vive en `ms-comparticion` y no en `ms-identidad` (las ADR-01 a ADR-06 están en el expediente del curso).

## Estilo arquitectónico

Microservicios (ADR-01 del expediente), cada uno dueño exclusivo de su base de datos, comunicación síncrona REST para el camino crítico y eventos (RabbitMQ) para el resto.

> **Nota de alcance de implementación:** el expediente documenta PostgreSQL + MongoDB políglota y un clúster de RabbitMQ de 3 nodos como arquitectura objetivo. Para el alcance de esta entrega académica, todos los servicios usan **MongoDB** (simplifica sin perder la garantía de unicidad — se logra con índices únicos) y **una sola instancia de RabbitMQ**, para que el equipo pueda desplegar y probar de verdad en el tiempo disponible. La arquitectura objetivo (documentada) no cambia; el despliegue de curso es un subconjunto reducido, igual que ya se hizo con Compartición/Analítica/Premium en el propio expediente.

## Servicios

| Servicio | Puerto | Estado | Historias |
|---|---|---|---|
| `services/ms-gateway` | 3000 | Único punto de entrada: valida el token y enruta por lista blanca | HU-02 |
| `services/ms-identidad` | 3001 | Registro, login, sesiones, registro del operador | HU-01, HU-02, HU-11 |
| `services/ms-documentos` | 3002 | Carga y consulta de documentos; recepción de documentos enviados por entidades emisoras | HU-03, HU-08, HU-10 (HU-09 pendiente) |
| `services/ms-notificaciones` | 3003 | Correos por eventos (confirmación de carga, bienvenida) | HU-03, HU-01 |
| `services/ms-interoperabilidad` | 3004 | Directorio de operadores y publicación del endpoint de transferencia | HU-05a, HU-05b (HU-05c pendiente) |
| `services/ms-comparticion` | 3005 | Registro **y autenticación** de entidades institucionales | HU-06.1, ADR-07 (HU-06.2 a 06.4 pendientes) |
| `services/ms-autenticacion` | — | Por empezar | HU-04 |

Infraestructura local (Docker): MongoDB `27017`, RabbitMQ `5672` (consola `15672`), MinIO `9000` (consola `9001`).

## Cómo correr localmente

### 1. Requisitos

- Docker Desktop en ejecución (con `docker compose`).
- Node.js 20 o superior y npm (solo para correr las pruebas fuera de Docker).
- Git.

### 2. Clonar

```bash
git clone https://github.com/jalopezg4/Arquitecturas-Avanzadas.git
cd Arquitecturas-Avanzadas
```

### 3. Definir las variables de entorno del compose

Cree un archivo `.env` en la **raíz del repositorio** (junto a `docker-compose.yml`; está ignorado por git). Solo la llave JWT es imprescindible:

```bash
JWT_SECRET=una-cadena-aleatoria-de-32-o-mas-caracteres
```

- `JWT_SECRET` la usan `ms-identidad` (firma), `ms-documentos` y `ms-gateway` (verifican): **debe ser la misma para los tres**, y el compose ya se la pasa a todos.
- `OPERATOR_ID` (opcional): el identificador del operador registrado en GovCarpeta. Pídalo al equipo; ver [`docs/OPERADOR_MINTIC.md`](docs/OPERADOR_MINTIC.md). **No vuelva a registrar el operador**: el directorio es compartido y permanente. Sin él, el registro de ciudadanos avisa al arrancar, pero los demás servicios funcionan.
- Correo real (opcional): por defecto `EMAIL_TRANSPORT=console`, que **no envía nada** y solo deja constancia del aviso. Para enviar de verdad defina `EMAIL_TRANSPORT=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` y `SMTP_PASS`.

### 4. Levantar todo

```bash
docker compose up -d --build
```

Espere hasta un minuto (RabbitMQ tarda en arrancar y `ms-notificaciones` se reconecta solo) y compruebe que responden (`/health` = el proceso vive; `/ready` = tiene sus dependencias):

```bash
curl http://localhost:3000/health
curl http://localhost:3002/ready
curl http://localhost:3003/ready
```

Para ver los registros de un servicio: `docker compose logs -f ms-documentos`. Para apagar todo: `docker compose down` (agregue `-v` si también quiere borrar los datos).

### 5. Probar el flujo completo (por el gateway, puerto 3000)

Registro (consulta el sandbox real de GovCarpeta y **crea un registro real en él**: use una cédula de prueba que no esté afiliada (el sandbox rechaza con `501` algunas identificaciones, p. ej. de 9 dígitos, sin que esté documentada la regla); se da de baja con `DELETE /apis/unregisterCitizen`):

```bash
curl -X POST http://localhost:3000/api/v1/citizens -H "Content-Type: application/json"   -d '{"documento":"1000000001","nombre":"Ana Perez","direccion":"Calle 1 # 2-3","correo":"ana@ejemplo.com","password":"Clave-segura-123"}'
```

Respuesta `201 {ciudadanoId, direccionUnica}`. Inicio de sesión:

```bash
curl -X POST http://localhost:3000/api/v1/auth/login -H "Content-Type: application/json"   -d '{"documento":"1000000001","password":"Clave-segura-123"}'
```

Devuelve `accessToken` (15 minutos) y `refreshToken`. Con el `accessToken` y el `ciudadanoId` del paso anterior:

```bash
# Cargar un PDF (HU-03)
curl -X POST http://localhost:3000/api/v1/citizens/<ciudadanoId>/documents   -H "Authorization: Bearer <accessToken>"   -F "titulo=Diploma de grado" -F "entidadAvaladora=Universidad EAFIT" -F "fecha=2026-03-15"   -F "archivo=@diploma.pdf;type=application/pdf"

# Consultar la carpeta, paginada (HU-08)
curl "http://localhost:3000/api/v1/citizens/<ciudadanoId>/documents?page=1&pageSize=10"   -H "Authorization: Bearer <accessToken>"
```

Un token de otro ciudadano recibe `403`; sin token, `401`. Los correos (modo `console`) quedan registrados en la base `ms-notificaciones`.

### 6. Correr las pruebas de un servicio

Las pruebas usan MongoDB en memoria: no requieren el compose. Cada servicio es independiente:

```bash
cd services/ms-documentos
npm install
cp .env.example .env     # solo si va a correr el servicio con npm run dev
npm test
npm run scan:secrets     # el mismo escáner de secretos que ejecuta el CI
```

Para correr un servicio fuera de Docker (`npm run dev`) necesita MongoDB, y según el servicio RabbitMQ y MinIO, en `localhost` (puede levantarlos con `docker compose up -d mongo rabbitmq minio`).

### 7. Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| `401 token invalido o expirado` desde el gateway o `ms-documentos` | `JWT_SECRET` distinto entre servicios: defina el mismo y recree con `docker compose up -d --force-recreate` |
| Un servicio no arranca y el registro dice `NODE_ENV es obligatorio` | Falta `NODE_ENV` (el compose ya lo define; fuera de él es obligatorio) |
| El registro responde `409` | El documento ya está afiliado en GovCarpeta o ya existe aquí |
| Las pruebas fallan o se quedan sin memoria | Cierre otros programas; los suites levantan un MongoDB en memoria cada uno |
| `docker compose` no conecta con el motor | Reinicie Docker Desktop |

## Documentación de seguridad y operación

- [`docs/SEGURIDAD.md`](docs/SEGURIDAD.md) — secretos, TLS, sesiones, gateway, documentos, límites conocidos.
- [`docs/OPERADOR_MINTIC.md`](docs/OPERADOR_MINTIC.md) — registro del operador y publicación del endpoint de transferencia.
