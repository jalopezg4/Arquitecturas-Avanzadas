# Buenas prácticas de arquitectura — referencia rápida

Machete de conceptos para tener presente mientras se programa cada HU. No es teoría suelta: cada sección dice dónde ya se usó (o se debería usar) en este proyecto.

## Principios de diseño

| Principio | Qué es | Dónde aplica aquí |
|---|---|---|
| **Bajo acoplamiento** | Los módulos dependen lo menos posible unos de otros | `ms-identidad` no conoce el código de `ms-documentos` — solo se comunican por evento (`ciudadano.registrado`) o HTTP |
| **Alta cohesión** | Un módulo tiene responsabilidades relacionadas entre sí | `GovCarpetaClient` solo habla con GovCarpeta; `CitizenRepository` solo persiste; nada se mezcla |
| **Separación de responsabilidades** | Cada parte resuelve un problema específico | La saga (`CitizenSagaService`) orquesta; el repositorio persiste; el cliente HTTP llama a GovCarpeta — tres archivos, tres trabajos |
| **DRY** | No repetir la misma lógica en varios lugares | Si dos HU necesitan generar una URL prefirmada (HU-04 y HU-09), es la misma función, no una copia por historia |
| **KISS** | Mantener las soluciones tan simples como sea razonable | Por eso el alcance de esta entrega usa un solo motor de BD (Mongo) en vez del diseño políglota completo del expediente |
| **YAGNI** | No construir algo que todavía no se necesita | No hay que meterle cache distribuido a `ms-documentos` si nadie ha medido que haga falta |
| **Dependency Injection** | Una clase recibe sus dependencias desde afuera | `CitizenSagaService` recibe `citizenRepository`, `govCarpetaClient` y `eventPublisher` por constructor — por eso se pudo testear con fakes sin tocar Mongo ni RabbitMQ de verdad |
| **Contrato / Interface** | Definir cómo dos componentes se comunican sin conocer sus detalles internos | El contrato de GovCarpeta (`docs/GOVCARPETA_CONTRATO.md`) es exactamente esto — no importa cómo está implementado del otro lado, solo el contrato |
| **Trade-off** | Toda decisión gana algo y sacrifica otra cosa | Usar MongoDB en vez de políglota gana simplicidad, pierde la garantía relacional fuerte que tenía el diseño objetivo — documentado, no escondido |

## SOLID (aplica sobre todo dentro de cada microservicio)

| Letra | Principio | Ejemplo en el repo |
|---|---|---|
| **S** | Single Responsibility | `GovCarpetaClient`, `EventPublisher`, `CitizenRepository` — cada uno una razón para cambiar |
| **O** | Open/Closed | Agregar un nuevo tipo de evento no debería obligar a reescribir `EventPublisher`, solo a llamar `publish()` con otra routing key |
| **L** | Liskov Substitution | Si más adelante se hace un `FakeGovCarpetaClient` para tests, debe poder sustituir al real sin romper `CitizenSagaService` (ya lo hacemos en los tests unitarios) |
| **I** | Interface Segregation | No forzar a un consumidor de eventos a implementar métodos de publicación que no necesita |
| **D** | Dependency Inversion | La saga depende de la *forma* de `govCarpetaClient` (que tenga `.validateCitizen()`, `.registerCitizen()`), no de axios directamente |

## Patrones usados o candidatos

- **Adapter**: `GovCarpetaClient` es un adapter — traduce el contrato real de GovCarpeta a algo que la saga puede usar sin saber de HTTP.
- **Facade**: si `ms-documentos` termina necesitando varias llamadas a S3 para una sola operación, conviene una fachada simple en vez de exponer el SDK crudo en el controller.
- **Strategy**: la interpretación configurable de `validateCitizen` (`GOVCARPETA_AVAILABLE_STATUS`) es básicamente esto — se puede cambiar el comportamiento sin tocar el resto del código.
- **Observer / Event-Driven**: todo el patrón pub/sub con RabbitMQ (`ciudadano.registrado` y lo que sigue) es Observer a nivel de arquitectura.

## Arquitectura (lo que ya decidimos y por qué)

- **Microservicios** (no monolito): aislamiento de fallas — que se caiga `ms-notificaciones` no debe tumbar el registro de ciudadanos. Ver matriz de degradación en `docs/ARQUITECTURA.md`.
- **Saga orquestada** (no transacción distribuida): para HU-01, que toca 4 sistemas sin una base compartida. Ver ADR-04 del expediente.
- **Puertos y adaptadores (idea, no dogma)**: `CitizenSagaService` no importa `axios` ni `mongoose` directamente — recibe objetos que cumplen un contrato. Es la misma idea de la Arquitectura Hexagonal aplicada sin necesidad de montar la estructura completa de carpetas `ports/`, `adapters/`.

## Atributos de calidad (para tener en mente al revisar un PR propio)

| Atributo | Pregunta que hay que hacerse |
|---|---|
| **Disponibilidad** | Si este servicio externo falla, ¿se cae todo o solo esa función? |
| **Escalabilidad** | ¿Esta lógica asume que solo hay una instancia corriendo? |
| **Seguridad** | ¿Hay algún secreto hardcodeado? ¿Se está validando ownership antes de cada operación sensible? |
| **Mantenibilidad** | ¿Alguien que no escribió esto podría entenderlo leyendo los nombres, sin preguntar? |
| **Testabilidad** | ¿Se puede probar esta lógica sin levantar Mongo/RabbitMQ reales? (si no, probablemente falta inyección de dependencias) |

## Checklist rápido antes de abrir un PR

- [ ] ¿La validación revisa tipos reales, no solo truthiness? (nos pasó en HU-01: `documento: "abc"` pasaba)
- [ ] ¿Hay algún secreto o URL hardcodeada que debería ser variable de entorno?
- [ ] ¿Un fallo en un servicio no crítico (notificaciones, analítica) puede tumbar una operación crítica (registro, login)?
- [ ] ¿Los tests usan fakes/mocks para las dependencias externas, o dependen de que algo real esté corriendo?
- [ ] ¿El nombre de la función/clase describe una sola responsabilidad?
