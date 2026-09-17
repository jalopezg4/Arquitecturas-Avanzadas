# Historias de Usuario — Carpeta Ciudadana

**Proyecto:** Operador de Carpeta Ciudadana (EAFIT)
**Curso:** Arquitecturas Avanzadas de Software
**Arquitectura de referencia:** `Arquitectura_Carpeta_Ciudadana.docx` — microservicios (ms-gateway, ms-identidad, ms-documentos, ms-autenticacion, ms-interoperabilidad, ms-notificaciones), PostgreSQL + MongoDB políglota, RabbitMQ como bus de eventos, saga orquestada con compensación.
**Nota de alcance:** esta versión reemplaza la anterior (que asumía monolito hexagonal + bcrypt + JWT 24h). Los story points, AC y tests aquí reflejan la arquitectura de microservicios ya aceptada (ADR-01 a ADR-06).

---

## HU-01: Registro de un ciudadano

**Microservicio dueño:** `ms-identidad` (orquesta la saga; consume `ms-documentos` y `ms-notificaciones` vía evento)
**Dominio:** Identidad y afiliación
**Prioridad:** 🔴 Alta
**Story Points:** 13 *(sube de 8 a 13: coordina 4 participantes externos como saga con compensación, no una llamada simple)*

**Descripción:**
Como ciudadano colombiano quiero registrarme ante un operador de Carpeta Ciudadana, para obtener mi carpeta digital y dejar de transportar mis propios documentos entre entidades.

**Escenario principal** (ver ADR-04 y Figura 5 del expediente):
1. `ms-gateway` recibe `POST /api/v1/citizens` y enruta a `ms-identidad`.
2. `ms-identidad` verifica la identidad contra el adaptador de Registraduría (simulado, contrato equivalente).
3. `ms-identidad` consulta `GET /apis/validateCitizen/{id}` en GovCarpeta.
4. Si el ciudadano está disponible, `ms-identidad` lo persiste en **estado `pendiente`** (primer paso de la saga).
5. `ms-identidad` llama `POST /apis/registerCitizen`. Si GovCarpeta confirma, pasa a **estado `activo`** y asigna la dirección única `@carpetacolombia.co`.
6. `ms-identidad` publica el evento `CiudadanoRegistrado` en RabbitMQ.
7. `ms-documentos` consume el evento, crea la carpeta y guarda la cédula firmada por la Registraduría.
8. `ms-notificaciones` consume el evento y envía el correo de bienvenida con la dirección única.

**Escenario alterno — ya afiliado:** GovCarpeta responde que el ciudadano ya está registrado → se rechaza sin persistir nada y se sugiere transferencia de operador (HU-05, backlog).

**Escenario alterno — compensación:** si GovCarpeta falla *después* de haber aceptado el registro, `ms-identidad` ejecuta la compensación: `DELETE /apis/unregisterCitizen`.

**Criterios de Aceptación:**
- ✅ `POST /api/v1/citizens` valida documento, nombre, dirección y correo antes de iniciar la saga
- ✅ El ciudadano se persiste en estado `pendiente` **antes** de llamar a GovCarpeta (no después)
- ✅ Solo pasa a `activo` cuando GovCarpeta confirma con 201
- ✅ Si GovCarpeta responde 204/501 (ya afiliado o error), se rechaza sin dejar registros huérfanos
- ✅ Si falla después de confirmado en GovCarpeta, se ejecuta `unregisterCitizen` como compensación
- ✅ La dirección única es inmutable y tiene restricción de unicidad a nivel de base de datos (índice único en PostgreSQL, no solo validación en código)
- ✅ Publica `CiudadanoRegistrado` en RabbitMQ solo cuando el estado ya es `activo`
- ✅ Consumidores (`ms-documentos`, `ms-notificaciones`) son idempotentes ante reintento del mismo evento
- ✅ Respuesta 201 con `{ciudadanoId, direccionUnica}`; 409 si documento ya existe; 400 si validación falla

**Tests Unitarios a implementar:**
```
ms-identidad: CitizenSagaService.register() persiste en estado pendiente antes de llamar GovCarpeta
ms-identidad: CitizenSagaService.register() confirma estado activo solo tras 201 de GovCarpeta
ms-identidad: CitizenSagaService.register() ejecuta compensación (unregisterCitizen) si falla tras confirmar
ms-identidad: CitizenSagaService.register() rechaza si GovCarpeta responde 204 (ya afiliado)
ms-identidad: GovCarpetaClient.validateCitizen() reintenta con backoff ante 500
ms-identidad: CitizenRepository rechaza segunda dirección única duplicada (constraint de BD)
ms-identidad: publica evento CiudadanoRegistrado solo si estado final es activo
ms-documentos: consumer de CiudadanoRegistrado crea carpeta e ignora duplicados (idempotencia)
ms-notificaciones: consumer de CiudadanoRegistrado envía correo de bienvenida con dirección única
POST /api/v1/citizens integración: 201, 409, 400 según caso
```

---

## HU-02: Autenticación del ciudadano en el operador (login)

**Microservicio dueño:** `ms-identidad`
**Dominio:** Identidad y afiliación
**Prioridad:** 🔴 Alta
**Story Points:** 5
**Requerimiento cubierto:** RF-38 (propuesto en el expediente, sección 9.3)

**Descripción:**
Como ciudadano ya registrado quiero iniciar sesión con mis credenciales, para acceder de forma segura a los documentos de mi carpeta.

**Escenario principal** (ver Figura 6):
1. `ms-identidad` recibe `{documento, password}`.
2. Recupera el resumen **Argon2id** almacenado (nunca la contraseña).
3. Verifica la contraseña contra el resumen.
4. Emite **token de sesión firmado con vigencia de 15 minutos** + **token de renovación** de vigencia mayor.
5. Registra el acceso en la bitácora de auditoría.

**Escenario alterno — credenciales inválidas:** mensaje genérico (sin revelar si el documento existe); al quinto intento fallido, bloqueo temporal de la cuenta.

**Criterios de Aceptación:**
- ✅ Password se verifica con **Argon2id**, no bcrypt
- ✅ Token de acceso expira en **15 minutos** (no 24h); token de renovación con vigencia mayor y de un solo uso por rotación
- ✅ Middleware de `ms-gateway` valida el token, y **cada microservicio lo vuelve a validar** (autorización no delegada solo al gateway — ADR-06)
- ✅ Respuesta 401 genérica sin distinguir "usuario no existe" de "password incorrecta"
- ✅ Contador de intentos fallidos por ciudadano; bloqueo temporal al 5º intento
- ✅ Registro en bitácora: ciudadano, timestamp, resultado (éxito/fallo)
- ✅ No involucra a GovCarpeta ni a la Registraduría (operación 100% local)

**Tests Unitarios a implementar:**
```
ms-identidad: AuthService.login() verifica password con Argon2id
ms-identidad: AuthService.login() emite access token de 15 min y refresh token
ms-identidad: AuthService.login() incrementa contador de intentos fallidos
ms-identidad: AuthService.login() bloquea cuenta al 5º intento fallido
ms-identidad: AuthService.login() responde 401 genérico si password no coincide
ms-identidad: AuthService.login() responde 401 genérico si el documento no existe (mismo mensaje)
ms-gateway: middleware JWT rechaza sin token o con token expirado
ms-identidad/ms-documentos/ms-autenticacion: cada servicio revalida el token (no confía ciegamente en el gateway)
AuditLogger.record() persiste intento de login exitoso/fallido con timestamp
```

---

## HU-03: Carga de un documento en la carpeta

**Microservicio dueño:** `ms-documentos`
**Dominio:** Gestión documental
**Prioridad:** 🔴 Alta
**Story Points:** 8

**Descripción:**
Como ciudadano quiero cargar un documento a mi carpeta, para conservarlo de forma permanente y compartirlo cuando lo necesite.

**Escenario principal** (ver Figura 7):
1. Ciudadano envía archivo + metadatos (título, entidad que avala, fecha).
2. `ms-documentos` verifica la cuota de documentos **no certificados** (temporal) — sin límite para certificados.
3. Almacena el archivo en el repositorio de objetos (S3-compatible) y obtiene la clave.
4. Guarda metadatos en estado `temporal` en MongoDB.
5. Publica `DocumentoCargado` en RabbitMQ y **responde de inmediato** al ciudadano (la notificación no bloquea la respuesta).
6. `ms-notificaciones` consume el evento y envía confirmación por correo.

**Escenario alterno — cuota alcanzada:** se rechaza sin almacenar el archivo; se informa el límite y se sugiere certificar o eliminar documentos temporales.

**Criterios de Aceptación:**
- ✅ `POST` requiere token JWT válido revalidado en `ms-documentos` (no solo en el gateway)
- ✅ Ownership check: solo el propietario del token puede cargar a su propia carpeta
- ✅ Cuota configurable solo aplica a documentos **no certificados** (RNF-04); certificados no consumen cuota
- ✅ Archivo se sube a object storage S3-compatible; solo se guarda la **clave**, nunca el binario, en MongoDB
- ✅ Metadatos persistidos en estado `temporal`
- ✅ Publica `DocumentoCargado` y responde 201 **antes** de esperar el envío de la notificación
- ✅ `ms-notificaciones` consume el evento de forma asíncrona e idempotente
- ✅ Respuesta 201 `{documentoId, url}`; 403 si no es dueño; 409 si cuota llena

**Tests Unitarios a implementar:**
```
ms-documentos: DocumentService.upload() rechaza si cuota de no-certificados está llena
ms-documentos: DocumentService.upload() no aplica cuota a documentos certificados
ms-documentos: DocumentService.upload() guarda solo la clave del objeto, no el binario, en MongoDB
ms-documentos: DocumentService.upload() persiste en estado temporal
ms-documentos: DocumentService.upload() publica DocumentoCargado y responde sin esperar al consumidor
ms-documentos: ObjectStorageAdapter.upload() genera clave única por ciudadano
ms-notificaciones: consumer de DocumentoCargado envía correo de confirmación (idempotente ante reintento)
POST /documents integración: 201, 403 (no dueño), 409 (cuota llena)
```

---

## HU-04: Autenticación de un documento a través de GovCarpeta

**Microservicio dueño:** `ms-autenticacion` (orquesta; `ms-documentos` posee el estado final del documento)
**Dominio:** Gestión documental / Integración MinTIC
**Prioridad:** 🔴 Alta
**Story Points:** 8

**Descripción:**
Como ciudadano quiero autenticar un documento que ya tengo en mi carpeta, para que quede certificado oficialmente y pueda presentarlo ante cualquier entidad.

**Escenario principal** (ver Figura 8):
1. Ciudadano solicita autenticar un documento `temporal`.
2. `ms-documentos` marca el documento en estado **`en autenticación`** y publica la solicitud en RabbitMQ; **responde de inmediato** al ciudadano (no espera a GovCarpeta).
3. `ms-autenticacion` consume el evento, genera una **URL prefirmada de lectura con vigencia de 15 minutos** sobre el archivo.
4. Invoca `PUT /apis/authenticateDocument` en GovCarpeta enviando cédula, URL y título — **nunca el archivo binario**.
5. Si GovCarpeta confirma, `ms-autenticacion` publica `DocumentoAutenticado`.
6. `ms-documentos` consume el evento y marca el documento como `certificado` con fecha de autenticación.
7. `ms-notificaciones` avisa al ciudadano.

**Escenario alterno — GovCarpeta falla o no responde:** reintentos con espera creciente (máx. 3); si se agotan, el mensaje va a la cola de fallidos, el documento vuelve a `temporal` y se notifica el fallo.

**Criterios de Aceptación:**
- ✅ Documento debe estar en estado `temporal` para poder autenticarse
- ✅ Ciudadano recibe respuesta de "solicitud recibida" **antes** de que GovCarpeta responda (operación asíncrona — RNF-10)
- ✅ URL prefirmada de exactamente **15 minutos** de vigencia; nunca se envía el archivo a GovCarpeta (RNF-13, RNF-14)
- ✅ Reintentos con backoff exponencial, máximo 3, antes de mover a cola de mensajes fallidos
- ✅ Si los reintentos se agotan, el documento **vuelve a `temporal`** (no se queda colgado en "en autenticación")
- ✅ Solo pasa a `certificado` cuando GovCarpeta confirma explícitamente
- ✅ Notificación asíncrona del resultado (éxito o fallo) al ciudadano

**Tests Unitarios a implementar:**
```
ms-documentos: DocumentService.requestAuthentication() rechaza si el documento no está en temporal
ms-documentos: DocumentService.requestAuthentication() responde de inmediato sin esperar a GovCarpeta
ms-autenticacion: PresignedUrlService.generate() crea URL con expiración de 15 minutos exactos
ms-autenticacion: GovCarpetaClient.authenticateDocument() nunca envía el binario, solo la URL
ms-autenticacion: GovCarpetaClient.authenticateDocument() reintenta hasta 3 veces con backoff creciente
ms-autenticacion: tras agotar reintentos, mensaje se mueve a cola de fallidos
ms-documentos: consumer de DocumentoAutenticado marca certificado con fecha
ms-documentos: si autenticación falla tras reintentos, documento vuelve a estado temporal
ms-notificaciones: consumer notifica éxito o fallo de autenticación
```

---

## Resumen Entrega 2

| HU | Título | Puntos | Microservicio | Estado |
|----|--------|--------|----------------|--------|
| 01 | Registro de un ciudadano (saga) | 13 | ms-identidad | Entrega 2 |
| 02 | Autenticación del ciudadano (login) | 5 | ms-identidad | Entrega 2 |
| 03 | Carga de un documento | 8 | ms-documentos | Entrega 2 |
| 04 | Autenticación de documento vía GovCarpeta | 8 | ms-autenticacion | Entrega 2 |
| **TOTAL ENTREGA 2** | | **34** | | |

> **⚠️ Hallazgo importante, releyendo la Entrega 1 completa (RF-01 a RF-37, RFP-01/02):** cuatro requerimientos de **prioridad Alta** no están cubiertos por ninguna HU en el expediente de arquitectura — ni en las 4 de Entrega 2, ni en los tres párrafos de backlog de la sección 3.3, ni en la tabla de trazabilidad 9.1. Son:
> - **RF-22 (Consulta de documentos)** — el ciudadano no tiene forma de ver qué hay en su carpeta
> - **RF-23 (Descarga de documentos)** — tampoco de sacarlos del sistema
> - **RF-11 (Recepción por dirección de carpeta)** — la entrada de documentos *enviados por una entidad emisora* (no cargados por el ciudadano) no está especificada en ninguna historia
> - **RF-34 (Registro del operador ante MinTIC)** — sin esto, ninguna llamada real a GovCarpeta (`validateCitizen`, `registerCitizen`, `authenticateDocument`) puede funcionar contra el sandbox; es prerrequisito técnico de HU-01 y HU-04
>
> Las agrego abajo como HU-08 a HU-11. No rompen la numeración del expediente (HU-05, 06 y 07 se mantienen como allí se nombraron) — se agregan a continuación para no reescribir lo que el profesor ya vio.

---

## Backlog (Entregas 3+) — cobertura completa de RF-01 a RF-37 y RFP-01/02

## HU-05: Transferencia de operador

**Microservicio dueño:** `ms-interoperabilidad`
**Dominio:** Interoperabilidad y transferencias
**Prioridad:** 🔴 Alta *(sube de Media: RF-07, RF-08 y RF-10 son "Alta" en la Entrega 1, no Media)*
**Story Points:** 13 (repartidos en 3 sub-historias — 13 puntos en una sola historia es demasiado grande para implementarse o probarse de una vez)
**Requerimientos cubiertos:** RF-07, RF-08, RF-10, RF-15, RF-16, RF-17, RF-18, RF-35

**Descripción:**
Como ciudadano quiero cambiar de operador conservando mis documentos y mi dirección única, mediante el protocolo de dos fases con confirmación entre operadores (`confirmAPI` / `transferCitizenConfirm`) acordado con los demás equipos del curso.

### HU-05a — Localización y directorio de operadores (RF-15, RF-16) — 3 pts
Como operador quiero consultar `GET /apis/getOperators` para saber a qué operador está afiliado un ciudadano antes de iniciar cualquier transferencia.
- ✅ Consulta el directorio de MinTIC y cachea localmente (copia local per ADR-03/entidad `Operador`)
- ✅ Resuelve la dirección de transferencia publicada por el operador destino

### HU-05b — Publicación de endpoint de transferencia (RF-35) — 2 pts
Como operador quiero registrar mi propio endpoint de recepción (`PUT /apis/registerTransferEndPoint`) ante MinTIC, para que otros operadores puedan iniciarme transferencias. *(Misma naturaleza operacional que HU-11 — no es un flujo iniciado por el ciudadano.)*
- ✅ Se ejecuta una vez por ambiente, igual que HU-11
- ✅ Falla explícitamente si el endpoint ya está publicado

### HU-05c — Transferencia con saga de dos fases (RF-07, RF-08, RF-10, RF-17, RF-18) — 8 pts
Como ciudadano quiero que mi cambio de operador se ejecute como una transacción segura: mis documentos y metadatos viajan directo al nuevo operador, y solo me borran del anterior cuando el nuevo confirma que ya me tiene completo.
- ✅ Protocolo de dos fases: origen inicia, destino confirma vía `confirmAPI`
- ✅ Documentos y metadatos viajan juntos, directo entre operadores, sin pasar por GovCarpeta (RNF-13, RNF-14)
- ✅ Timeout de 5 minutos con reintentos antes de marcar la transferencia como fallida
- ✅ Carpeta en modo solo-lectura en el origen mientras la transferencia está en curso
- ✅ `transferCitizenConfirm` es idempotente ante reintentos de red
- ✅ Solo se borra al ciudadano del origen (RF-08) tras confirmación explícita del destino
- ✅ La dirección única **no cambia** tras la transferencia (RF-10)

**Tests Unitarios a implementar:**
```
ms-interoperabilidad: OperatorDirectoryService.findOperator() localiza destino vía getOperators (HU-05a)
ms-interoperabilidad: OperatorDirectoryService cachea el directorio localmente (HU-05a)
ms-interoperabilidad: EndpointRegistrationService.publish() falla si ya está publicado (HU-05b)
ms-interoperabilidad: TransferSagaService.initiate() bloquea la carpeta en modo solo-lectura (HU-05c)
ms-interoperabilidad: TransferSagaService.initiate() reintenta hasta agotar timeout de 5 min (HU-05c)
ms-interoperabilidad: TransferConfirmService.confirm() es idempotente ante el mismo id repetido (HU-05c)
ms-interoperabilidad: TransferSagaService solo borra al ciudadano tras confirmación del destino (HU-05c)
ms-identidad: dirección única se conserva sin cambios tras transferCitizenConfirm exitoso (HU-05c)
```

---

## HU-06: Compartición autorizada de documentos

**Microservicio dueño:** por definir en Entrega 3 (posible `ms-comparticion`)
**Dominio:** Compartición, solicitudes y consentimiento
**Prioridad:** 🔴 Alta *(los 7 RF que cubre son "Alta" en la Entrega 1)*
**Story Points:** 21 *(sube de 8: cubre 7 RF con flujos distintos — se recomienda desglosar, ver sub-historias)*
**Requerimientos cubiertos:** RF-24, RF-25, RF-26, RF-27, RF-29, RF-31, RF-37

**Descripción:**
Como ciudadano quiero armar paquetes documentales y autorizar el envío de los documentos que una entidad me solicita, para compartir solo lo necesario y con mi consentimiento explícito.

**Recomendación:** este HU es demasiado grande para implementarse de una vez (7 RF, 3 actores distintos: ciudadano, entidad emisora, entidad receptora). Se sugiere desglosarlo así para Entrega 3:

### HU-06.1 — Registro de entidad institucional (RF-37)
Como entidad (notaría, universidad, empresa) quiero registrarme como institución en el operador, para tener una carpeta institucional que reciba paquetes documentales. **Prerrequisito de HU-06.2.** — 5 pts

### HU-06.2 — Creación y entrega de paquete documental (RF-24, RF-25, RF-26)
Como ciudadano quiero seleccionar varios documentos de mi carpeta y enviarlos juntos a una entidad, entregándolos a su carpeta institucional si está afiliada (RF-25) o por correo electrónico si no lo está (RF-26). — 8 pts
- ✅ El paquete no duplica archivos, solo referencia documentos ya existentes en la carpeta del ciudadano
- ✅ Si la entidad tiene carpeta institucional (HU-06.1), la entrega es interna al ecosistema
- ✅ Si no, se genera un envío por correo con enlace de descarga temporal

### HU-06.3 — Solicitud de documentos por una entidad + autorización del ciudadano (RF-27, RF-28, RF-29)
Como entidad receptora quiero solicitar documentos específicos de un ciudadano; como ciudadano quiero recibir la notificación (correo y SMS, RF-28) y autorizar explícitamente el envío antes de que se comparta nada. — 8 pts
- ✅ Nada se comparte hasta que el ciudadano autoriza explícitamente (RF-29) — este es el punto de consentimiento explícito exigido por el caso de estudio
- ✅ Notificación de la solicitud por **correo Y SMS** (RF-28 exige ambos canales, a diferencia de RF-21 que solo exige correo)

### HU-06.4 — Solicitud de documento definitivo a la entidad emisora (RF-31)
Como ciudadano que cargó un documento temporal (HU-03, escenario RF-30) quiero solicitar a la entidad emisora el documento oficial definitivo, para reemplazar el temporal cuando esté disponible. — 5 pts

---

## HU-07: Servicios Premium y analítica de metadatos

**Microservicio dueño:** por definir en Entrega 3
**Dominio:** Servicios Premium / Analítica
**Prioridad:** 🟡 Media *(RF-33, RFP-01, RFP-02 son prioridad "Media" en la Entrega 1)*
**Story Points:** 8
**Requerimientos cubiertos:** RF-33, RFP-01, RFP-02

**Descripción:**
Como entidad institucional (notaría, universidad, Registraduría) quiero gestionar casos de PQRS con solicitud documental multioperador y explotar analíticamente los metadatos, como servicio Premium cobrable del operador.

### HU-07.1 — Analítica de metadatos (RF-33) — 3 pts
Como Estado (notarías, instituciones de educación, Registraduría) quiero consultar analíticamente los metadatos almacenados, sin acceder al contenido de los documentos.

### HU-07.2 — Gestión de casos PQRS (RFP-01) — 3 pts
Como operador Premium quiero crear y organizar casos de soporte asociados a documentos de peticiones, quejas, reclamos y solicitudes.

### HU-07.3 — Solicitud documental multioperador (RFP-02) — 2 pts
Como operador Premium quiero solicitar documentos a clientes sin importar en qué operador del ecosistema estén afiliados.

---

## HU-08: Consulta de documentos *(NUEVA — cubre RF-22, ausente en el expediente)*

**Microservicio dueño:** `ms-documentos`
**Dominio:** Custodia y gestión documental
**Prioridad:** 🔴 Alta
**Story Points:** 5
**Requerimiento cubierto:** RF-22

**Descripción:**
Como ciudadano quiero consultar los documentos almacenados en mi carpeta, para saber qué tengo disponible antes de compartirlo o descargarlo.

**Criterios de Aceptación:**
- ✅ `GET /api/v1/citizens/{id}/documents` requiere JWT revalidado en `ms-documentos` (no solo en el gateway)
- ✅ Ownership check: un ciudadano solo consulta su propia carpeta
- ✅ Paginación: `page` (default 1), `pageSize` (default 10, máx. 100)
- ✅ Cada elemento incluye: documentoId, título, estado (`temporal`/`en autenticación`/`certificado`), entidad avaladora, fechas (RF-19, RF-20)
- ✅ Respuesta 200 incluso si la carpeta está vacía
- ✅ Respuesta 403 si el token pertenece a otro ciudadano

**Tests Unitarios a implementar:**
```
ms-documentos: DocumentService.list() retorna solo documentos del ciudadano autenticado
ms-documentos: DocumentService.list() pagina con page/pageSize, máximo 100
ms-documentos: DocumentService.list() retorna 200 vacío si no hay documentos
GET /documents integración: 403 si el ownership no coincide con el token
```

---

## HU-09: Descarga de documentos *(NUEVA — cubre RF-23, ausente en el expediente)*

**Microservicio dueño:** `ms-documentos`
**Dominio:** Custodia y gestión documental
**Prioridad:** 🔴 Alta
**Story Points:** 3
**Requerimiento cubierto:** RF-23

**Descripción:**
Como ciudadano quiero descargar un documento de mi carpeta, para usarlo fuera del sistema (imprimirlo, adjuntarlo a un trámite externo).

**Criterios de Aceptación:**
- ✅ `GET /documents/{id}/download` requiere JWT revalidado en `ms-documentos`
- ✅ Ownership check antes de generar cualquier URL
- ✅ Reutiliza el mismo mecanismo de URL prefirmada que HU-04 (consistencia arquitectónica — ADR-06), pero con vigencia propia (se sugiere 1 hora, a diferencia de los 15 min de autenticación, por ser iniciada por el ciudadano y no expuesta a un tercero)
- ✅ Respuesta 404 si el documento no existe; 403 si no es el dueño
- ✅ Queda registro en bitácora de auditoría (RF-39 propuesto / RNF-07)

**Tests Unitarios a implementar:**
```
ms-documentos: DocumentService.download() genera URL prefirmada de 1 hora
ms-documentos: DocumentService.download() rechaza si el ciudadano no es dueño
ms-documentos: DocumentService.download() retorna 404 si el documento no existe
AuditLogger.record() persiste cada descarga con ciudadano, documento y timestamp
```

---

## HU-10: Recepción de documento enviado por entidad emisora *(NUEVA — cubre RF-11, ausente en el expediente)*

**Microservicio dueño:** `ms-documentos`
**Dominio:** Custodia y gestión documental
**Prioridad:** 🔴 Alta
**Story Points:** 8
**Requerimiento cubierto:** RF-11, RF-13 (sin límite de tamaño para certificados)

**Descripción:**
Como entidad emisora (universidad, notaría, empleador) quiero enviar un documento firmado directamente a la dirección única de un ciudadano, para que quede disponible en su carpeta sin que él tenga que cargarlo manualmente.

**Nota de alcance:** esta historia es distinta de HU-03 (donde el *ciudadano* carga su propio documento temporal). Aquí la entidad empuja un documento ya certificado hacia la carpeta — es el mecanismo real detrás de "recibir el diploma de la universidad" o "recibir la escritura de la notaría" sin que el ciudadano intervenga.

**Criterios de Aceptación:**
- ✅ La entidad emisora se autentica con sus propias credenciales (no las del ciudadano)
- ✅ El envío se dirige por la **dirección única** del ciudadano (`documento@carpetacolombia.co`), no por su ID interno
- ✅ El documento entra directamente en estado `certificado` (ya viene firmado por la entidad) — a diferencia de HU-03, no pasa por `temporal`
- ✅ Sin límite de tamaño para documentos certificados (RF-13, RNF-04)
- ✅ Publica el mismo evento `DocumentoCargado`/notificación que HU-03, para reutilizar el consumidor de `ms-notificaciones` (RF-21)

**Tests Unitarios a implementar:**
```
ms-documentos: InboundDocumentService.receive() resuelve al ciudadano por dirección única
ms-documentos: InboundDocumentService.receive() persiste directo en estado certificado
ms-documentos: InboundDocumentService.receive() no aplica límite de tamaño ni cuota
ms-documentos: InboundDocumentService.receive() rechaza si la dirección única no existe
ms-notificaciones: consumer reutilizado notifica al ciudadano del documento entrante
```

---

## HU-11: Registro del operador en el ecosistema MinTIC *(NUEVA — cubre RF-34, prerrequisito técnico)*

**Microservicio dueño:** `ms-identidad` o script de arranque de infraestructura (no es una operación de usuario final)
**Dominio:** Servicios de integración con MinTIC
**Prioridad:** 🔴 Alta — **bloqueante**: sin esto, HU-01 y HU-04 no pueden probarse contra el GovCarpeta real
**Story Points:** 2
**Requerimiento cubierto:** RF-34

**Descripción:**
Como equipo operador quiero registrar nuestro sistema ante MinTIC (`POST /apis/registerOperator`) antes de cualquier prueba de integración, para obtener el `operatorId` que todas las demás llamadas a GovCarpeta requieren.

**Criterios de Aceptación:**
- ✅ Se ejecuta **una sola vez** por ambiente (dev/staging/prod), no en cada arranque del servicio
- ✅ El `operatorId` obtenido se guarda en configuración (variable de entorno o secreto), no hardcodeado
- ✅ Falla de forma clara y explícita si el registro ya existe (evita duplicar operadores en el sandbox del curso)
- ✅ Es prerrequisito documentado de HU-01, HU-04 y HU-05 (todas dependen de que el operador ya esté registrado)

**Tests Unitarios a implementar:**
```
OperatorBootstrap.register() persiste operatorId en configuración tras 201
OperatorBootstrap.register() falla con mensaje claro si el operador ya existe
```

---

## Resumen Backlog completo (funcional — cubre RF/RFP)

| HU | Título | Puntos | Prioridad |
|----|--------|--------|-----------|
| 05a | Localización y directorio de operadores | 3 | 🔴 Alta |
| 05b | Publicación de endpoint de transferencia | 2 | 🔴 Alta |
| 05c | Transferencia con saga de dos fases | 8 | 🔴 Alta |
| 06.1 | Registro de entidad institucional | 5 | 🔴 Alta |
| 06.2 | Paquete documental y entrega | 8 | 🔴 Alta |
| 06.3 | Solicitud + autorización de envío | 8 | 🔴 Alta |
| 06.4 | Solicitud de documento definitivo | 5 | 🔴 Alta |
| 07.1 | Analítica de metadatos | 3 | 🟡 Media |
| 07.2 | Gestión de casos PQRS | 3 | 🟡 Media |
| 07.3 | Solicitud documental multioperador | 2 | 🟡 Media |
| 08 | Consulta de documentos | 5 | 🔴 Alta |
| 09 | Descarga de documentos | 3 | 🔴 Alta |
| 10 | Recepción de documento por entidad emisora | 8 | 🔴 Alta |
| 11 | Registro del operador en MinTIC | 2 | 🔴 Alta (bloqueante) |
| **TOTAL BACKLOG FUNCIONAL** | **14 historias** | **65** | |

---

## Historias técnicas / habilitadoras (RNF) — no estaban en ninguna versión anterior

Estas no nacen de un RF sino de los RNF y de los propios "Impactos e implicaciones" de las ADR del expediente (sección 8). Son trabajo real de arquitectura que un backlog completo no puede omitir, aunque no tengan un "Como ciudadano quiero..." — son habilitadores para que las historias funcionales cumplan sus RNF.

### HT-01: Health checks y degradación controlada por servicio
**Cubre:** RNF-01 (disponibilidad ≥99,5%) · **Puntos:** 3
Cada microservicio expone `/health` y `/ready`; el gateway deja de enrutar a una instancia no saludable. Verificable contra la matriz de degradación (sección 4.5 del expediente).

### HT-02: Respaldo y restauración verificada de almacenamiento
**Cubre:** RNF-03 (durabilidad, recuperar 100% sin corrupción) · **Puntos:** 5
Prueba periódica automatizada de restauración sobre PostgreSQL, MongoDB y el object storage — no basta con que el proveedor diga que hace backups, hay que probar la restauración.

### HT-03: Pruebas de capacidad y escalamiento horizontal
**Cubre:** RNF-02 (1M carpetas lógicas, duplicar carga sin rediseño) · **Puntos:** 5
Prueba de carga sobre `ms-documentos` (servicio crítico, 3 réplicas) verificando que el autoescalamiento por CPU responde antes de degradar latencia.

### HT-04: Bitácora de auditoría de accesos
**Cubre:** RF-39 (propuesto en expediente 9.3) y RNF-07 (0 accesos fuera de política, verificable) · **Puntos:** 3
Sin esto, RNF-07 no es *auditable* — es la pieza que falta para poder demostrar el criterio de aceptación, no solo cumplirlo.

### HT-05: Suite de pruebas de contrato de interoperabilidad
**Cubre:** RNF-11 (100% de casos válidos con un operador de referencia) · **Puntos:** 5
Pruebas de contrato automatizadas contra el protocolo `confirmAPI`/`transferCitizenConfirm` acordado con los otros equipos del curso — necesarias antes de integrar con un operador real de otro grupo.

### HT-06: Trazabilidad distribuida entre microservicios
**Cubre:** impacto tecnológico declarado en ADR-01 ("se requiere trazabilidad distribuida para depurar una petición que atraviesa varios servicios") · **Puntos:** 5
Sin esto, depurar un fallo en la saga de HU-01 (4 sistemas externos) es prácticamente imposible en producción.

### HT-07: Gestión de secretos y TLS/mTLS entre servicios
**Cubre:** RNF-05 (confidencialidad) y el impacto de ADR-06 ("política de expiración de URLs aplicada en el repositorio de objetos") · **Puntos:** 3
Certificados y rotación de credenciales por servicio — hoy solo está descrito en la ADR, no como trabajo a ejecutar.

**Total historias técnicas: 7 historias, 29 puntos**

---

## Gran total del proyecto

| Categoría | Historias | Puntos |
|---|---|---|
| Entrega 2 (funcional) | 4 | 34 |
| Backlog funcional (RF/RFP) | 14 | 65 |
| Historias técnicas (RNF) | 7 | 29 |
| **TOTAL** | **25** | **128** |

Para comparar: la primera versión que te di tenía 15 HU inventadas (algunas sin respaldo en ningún RF real) sumando 80 puntos. Esta versión tiene **25 historias, todas trazables a un RF, RFP o RNF específico de la Entrega 1**, sumando 128 puntos. La cobertura real del proyecto completo es más grande de lo que parecía — no porque haya inflado el alcance, sino porque la primera vez no había leído los RF-01 a RF-37 originales, solo el resumen por dominios del expediente.

---

## ⚠️ Dos acciones pendientes

**1. Reconciliar con GitHub.** Ya existen 6 issues creados (#7-#12) con la numeración y alcance antiguos (incluían "Listar documentos" y "Descargar documento" con AC de monolito/bcrypt). Ahora que HU-08 y HU-09 cubren exactamente esas dos funciones pero con AC correctos (microservicios, ownership revalidado, URL prefirmada), hay que decidir: ¿editar los issues #7-#12 para que apunten a las HU correctas de este documento, o cerrarlos y recrear todo con la numeración de aquí (HU-01 a HU-11)?

**2. Llevar el hallazgo de RF-22, RF-23, RF-11 y RF-34 al equipo.** El expediente de arquitectura que ya entregaron/van a entregar no menciona estas cuatro historias en ningún lado — ni siquiera en la tabla de trazabilidad de la sección 9.1. Vale la pena que el equipo decida si las agrega al documento (como ya se hizo con RF-38 y RF-39) antes de la sustentación, para que no sea el profesor quien note el vacío primero.
