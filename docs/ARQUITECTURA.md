# Resumen de arquitectura

Fuente completa: `Arquitectura_Carpeta_Ciudadana.docx` (carpeta del curso, un nivel arriba de este repo). Este archivo es un resumen operativo para no tener que abrir el Word constantemente mientras se programa.

## Estilo (ADR-01)

Microservicios, cada uno propietario exclusivo de su base de datos. Comunicación síncrona REST para el camino crítico, eventos (RabbitMQ) para el resto.

## Microservicios y sus historias

| Microservicio | Responsabilidad | Historias |
|---|---|---|
| `ms-gateway` | Enrutamiento, TLS, validación JWT | — |
| `ms-identidad` | Registro, login, portabilidad | HU-01, HU-02, HU-11 |
| `ms-documentos` | Carga, consulta, descarga, custodia | HU-03, HU-08, HU-09, HU-10 |
| `ms-autenticacion` | Autenticación documental con GovCarpeta | HU-04 |
| `ms-interoperabilidad` | Transferencias entre operadores | HU-05a, HU-05b, HU-05c |
| `ms-notificaciones` | Correo y SMS | consumidor transversal |
| (por definir E3) | Compartición, Analítica, Premium | HU-06.x, HU-07.x |

## Decisiones clave que afectan el código (ADRs 2-6)

- **Persistencia**: objetivo documentado es políglota (PostgreSQL para identidad/interoperabilidad, MongoDB para el resto). **Para esta entrega usamos MongoDB en todos** — ver nota de alcance en el README principal.
- **Seguridad (ADR-06)**: contraseñas con **Argon2id** (no bcrypt). Tokens de sesión firmados de **15 minutos** + refresh token de vigencia mayor. Autorización verificada en cada microservicio, no solo en el gateway. URLs prefirmadas de vigencia limitada para exponer archivos a terceros (GovCarpeta: 15 min; descarga propia del ciudadano: 1 hora).
- **Comunicación asíncrona y saga (ADR-04)**: el registro de ciudadano (HU-01) es una **saga orquestada por ms-identidad** con compensación explícita (`unregisterCitizen` si algo falla después de confirmar en GovCarpeta). Todo lo que no es camino crítico va por evento (RabbitMQ), con reintentos y cola de mensajes fallidos.
- **Object storage**: compatible S3, solo se guarda la clave del objeto en la base de datos, nunca el binario.

## Matriz de degradación (sección 4.5 del expediente)

`ms-documentos` es el servicio crítico (3 réplicas en el diseño objetivo). La caída de `ms-notificaciones`, `ms-autenticacion` o `ms-interoperabilidad` **no debe** afectar registro, login, carga, consulta o descarga — esas operaciones deben seguir funcionando aunque esos otros servicios estén caídos.

## Hallazgos de esta sesión (no estaban en el expediente original)

Cuatro RF de prioridad Alta no tenían HU en el expediente: RF-22 (consulta), RF-23 (descarga), RF-11 (recepción por entidad emisora), RF-34 (registro del operador). Ahora son HU-08, HU-09, HU-10, HU-11 respectivamente — ver `HISTORIAS_DE_USUARIO.md`.
