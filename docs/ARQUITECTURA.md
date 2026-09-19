# Resumen de arquitectura

Fuente completa: `Arquitectura_Carpeta_Ciudadana.docx` (carpeta del curso, un nivel arriba de este repo). Este archivo es un resumen operativo para no tener que abrir el Word constantemente mientras se programa.

## Estilo (ADR-01)

Microservicios, cada uno propietario exclusivo de su base de datos. Comunicación síncrona REST para el camino crítico, eventos (RabbitMQ) para el resto.

## Microservicios y sus historias

| Microservicio | Responsabilidad | Historias |
|---|---|---|
| `ms-gateway` | Enrutamiento, TLS, validación JWT | HU-02 (validación de token; ver `docs/SEGURIDAD.md`, sección 6) |
| `ms-identidad` | Registro, login, portabilidad | HU-01, HU-02, HU-11 |
| `ms-documentos` | Carga, consulta, descarga, custodia | HU-03, HU-08, HU-09, HU-10 |
| `ms-autenticacion` | Autenticación documental con GovCarpeta | HU-04 |
| `ms-interoperabilidad` | Transferencias entre operadores | HU-05a, HU-05b, HU-05c |
| `ms-notificaciones` | Correo y SMS | consumidor transversal |
| (por definir E3) | Compartición, Analítica, Premium | HU-06.x, HU-07.x |

## Decisiones clave que afectan el código (ADRs 2-6)

- **Persistencia**: objetivo documentado es políglota (PostgreSQL para identidad/interoperabilidad, MongoDB para el resto). **Para esta entrega usamos MongoDB en todos** — ver nota de alcance en el README principal.
- **Seguridad (ADR-06)**: ver `docs/SEGURIDAD.md` (secretos, TLS/mTLS, rotación). Contraseñas con **Argon2id** (no bcrypt). Tokens de sesión firmados de **15 minutos** + refresh token de vigencia mayor. Autorización verificada en cada microservicio, no solo en el gateway. URLs prefirmadas de vigencia limitada para exponer archivos a terceros (GovCarpeta: 15 min; descarga propia del ciudadano: 1 hora).
- **Comunicación asíncrona y saga (ADR-04)**: el registro de ciudadano (HU-01) es una **saga orquestada por ms-identidad** con compensación explícita (`unregisterCitizen` si algo falla después de confirmar en GovCarpeta). Todo lo que no es camino crítico va por evento (RabbitMQ), con reintentos y cola de mensajes fallidos.
- **Object storage**: compatible S3, solo se guarda la clave del objeto en la base de datos, nunca el binario. En desarrollo local es **MinIO** (`quay.io/minio/minio`, ya no se publica en Docker Hub); en despliegue, S3 u otro proveedor compatible. Detalle de la carga en `docs/SEGURIDAD.md`, sección 7.

## Matriz de degradación (sección 4.5 del expediente)

`ms-documentos` es el servicio crítico (3 réplicas en el diseño objetivo). La caída de `ms-notificaciones`, `ms-autenticacion` o `ms-interoperabilidad` **no debe** afectar registro, login, carga, consulta o descarga — esas operaciones deben seguir funcionando aunque esos otros servicios estén caídos.

## Hallazgos de esta sesión (no estaban en el expediente original)

Cuatro RF de prioridad Alta no tenían HU en el expediente: RF-22 (consulta), RF-23 (descarga), RF-11 (recepción por entidad emisora), RF-34 (registro del operador). Ahora son HU-08, HU-09, HU-10, HU-11 respectivamente — ver `HISTORIAS_DE_USUARIO.md`.

## Observabilidad transversal (HT-04 auditoría, HT-06 trazabilidad)

Ambas viven hoy en `ms-identidad` (`src/tracing/`, `AuditLogger`) y **cada servicio nuevo debe replicarlas** al crearse (`ms-documentos`, `ms-autenticacion`, etc.). Extraerlas a un paquete compartido queda como decisión pendiente (YAGNI mientras solo exista un servicio).

**Bitácora de auditoría (RNF-07).** Colección `audit_logs`, append-only a nivel de aplicación: quién (actor), qué (acción), sobre qué recurso y de quién, resultado (`exito`/`fallo`/`rechazo`), motivo, timestamp y trace-id. `AuditQueryService.verifyNoOutOfPolicyAccess({from,to})` responde si hubo accesos exitosos a recursos ajenos no delegados. Cada servicio audita en **su propia base** (base por servicio); verificar RNF-07 globalmente exige consultarlos todos. Limitación: quien tenga acceso directo a Mongo puede borrar entradas.

**Trazabilidad distribuida.** Cada petición lleva un trace-id (header `x-trace-id`):
- Se reutiliza el que llega (gateway u otro servicio) si tiene formato válido (`[A-Za-z0-9._-]{8,64}`, evita inyección de líneas de log) o se genera uno; se devuelve en la respuesta.
- Viaja por todo el código sin pasarlo por parámetros (`AsyncLocalStorage`) y se **propaga hacia afuera**: header en las llamadas a GovCarpeta y en los headers del mensaje de RabbitMQ (el consumidor debe retomarlo con `runWithTrace`).
- Logs en una línea JSON (`ts`, `level`, `service`, `traceId`, `msg`, campos). **No se registran datos personales** (documento, correo, password).

Reconstruir el recorrido de una petición (funciona con logs de varios servicios mezclados):

```bash
docker compose logs --no-color | node services/ms-identidad/scripts/trace.js <trace-id>
```

Muestra la línea de tiempo y el primer error (`saga.paso_fallido` indica el paso exacto). No sustituye a un agregador centralizado (ELK/Loki): trabaja sobre el texto que recibe.
