# Guía de sustentación

Qué mostrar y cómo justificarlo ante los cuatro criterios de evaluación: **granularidad**, **sustentación de la arquitectura**, **decisiones y tecnologías**, y **prueba de que el sistema sigue funcionando al borrar un servicio**. Todo lo que aquí se afirma fue verificado en ejecución real (Docker local, GovCarpeta real) el 2026-10-01.

---

## 1. Preparar la demostración (5 minutos antes)

```bash
docker compose up -d --build        # los 8 microservicios + MongoDB, RabbitMQ y MinIO
node demo-web/server.js             # cliente web de demostración en http://localhost:5173
```

El `.env` de la raíz debe tener `JWT_SECRET` y `OPERATOR_ID` (ver README, paso 3). Esperar ~1 minuto a que RabbitMQ arranque.

La página tiene dos partes:
- **Flujo del ciudadano** (las 4 funcionalidades de la Entrega 2): registro, login, carga y autenticación.
- **Panel de resiliencia**: apaga, borra o vuelve a encender cualquier contenedor y prueba todas las operaciones en un clic, con lo que la matriz de degradación de la arquitectura dice que debe pasar escrito junto a cada servicio.

---

## 2. Guion sugerido (≈10 minutos)

1. **Contexto (1 min).** Operador de Carpeta Ciudadana: custodia los documentos del ciudadano y se integra con el centralizador del MinTIC (GovCarpeta) y con otros operadores. El atributo de calidad dominante es la **disponibilidad** ("disponibilidad prácticamente total" en el caso de estudio), seguido de la escalabilidad.
2. **Las 4 operaciones (3 min), en la página:**
   - **Registro:** consulta la Registraduría (simulada), valida contra GovCarpeta real que no esté afiliado y lo registra; responde con la dirección única @carpetacolombia.co.
   - **Login:** Argon2id y un token firmado de 15 minutos.
   - **Carga de un PDF:** queda **temporal**.
   - **Autenticar:** el documento pasa a *en autenticación* y, unos segundos después, a **✓ certificado**. Señalar el panel de llamadas: cada botón es una petición real al gateway.
3. **Resiliencia (4 min), en el panel.** Borrar contenedores en vivo (ver sección 3), uno a la vez, pulsando **Probar operaciones** después de cada uno y **Encender** antes del siguiente.
4. **Cierre (2 min).** Granularidad y decisiones (secciones 4 y 5), y límites conocidos (sección 7).

---

## 3. "Borro un servicio y sigue funcionando": resultados reales

Prueba automatizada sobre el sistema completo: se apaga cada elemento y se ejecutan login, consulta, descarga, carga y autenticación a través del gateway.

| Elemento apagado | Login | Consulta | Descarga | Carga | Autenticación | Coincide con la matriz 4.5 |
|---|---|---|---|---|---|---|
| (todo arriba) | ✅ | ✅ | ✅ | ✅ | ✅ certificado | — |
| ms-notificaciones | ✅ | ✅ | ✅ | ✅ | ✅ certificado | ✅ los correos llegan al volver |
| ms-autenticacion | ✅ | ✅ | ✅ | ✅ | ⏳ en cola → se completó al volver | ✅ |
| ms-interoperabilidad | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ms-comparticion | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ms-analitica | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **ms-identidad** | ❌ (falla rápido) | ✅ con la sesión vigente | ✅ | ✅ | ✅ | ✅ "si ya tiene sesión, opera con normalidad" |
| **ms-documentos** | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ es el servicio crítico |
| RabbitMQ (bus) | ✅ | ✅ | ✅ | ✅ (3 s) | ⏳ en cola → se completó al volver, **sin reiniciar ningún servicio** | ✅ |
| MinIO (almacenamiento) | ✅ | ✅ | ❌ archivo | ❌ (`503`) | — | (no está en la matriz) |
| 1 de 3 réplicas de ms-documentos | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ redundancia del crítico |

Las autenticaciones que quedaron "en cola" terminaron certificadas solas al restablecerse el servicio: al final de la prueba los 13 documentos estaban certificados. Qué decir en cada caso:
- **Notificaciones o autenticación caídas:** el ciudadano no lo percibe. Los mensajes esperan en su cola durable de RabbitMQ y se procesan al volver (ADR-04).
- **Identidad caída:** nadie nuevo entra, pero quien ya tiene sesión sigue operando. Cada servicio **valida el token por sí mismo** (ADR-06), así que no depende de identidad en cada petición.
- **Documentos caído:** es el servicio crítico, por eso la arquitectura le da 3 réplicas. Demostrarlo con el botón **3 réplicas**, luego **Apagar 1 réplica** y **Probar operaciones**: todo sigue en verde.
- **Bus caído:** carga y autenticación responden igual. Lo diferido se acumula, los publicadores se reconectan solos y un reconciliador reenvía lo que no alcanzó a publicarse.

**Fallar rápido (cortacircuitos en el gateway).** Medido: al borrar `ms-documentos`, el primer intento antes tardaba **24 s** en devolver error, porque el gateway esperaba la conexión. Ahora tarda **2,7 s** (plazos de DNS y de conexión) y los siguientes **0,05 s** (`503` inmediato, circuito abierto). Al volver el servicio, una petición de prueba lo detecta y el circuito se cierra solo. `GET /ready` del gateway muestra qué circuitos están abiertos.

---

## 4. Granularidad: por qué estos 8 servicios

**Criterio:** un servicio por **capacidad de negocio** de la vista lógica (los dominios de la Entrega 1), separados además cuando difieren en **perfil de carga**, en **dependencia de un sistema externo lento o caído**, o en **quién es dueño de los datos**. Cada servicio es dueño exclusivo de su base y nadie lee la base de otro: lo que necesita lo obtiene por API o por evento.

| Servicio | Dominio (Entrega 1) | Dueño de | Por qué es un servicio aparte |
|---|---|---|---|
| ms-gateway | — | nada | Punto único de entrada: lista blanca de rutas, primera validación del token, trazabilidad, cortacircuitos |
| ms-identidad | 1.1 Identidad y afiliación | ciudadanos, credenciales, sesiones | Integra Registraduría y GovCarpeta (lentos); carga esporádica |
| ms-documentos | 1.2 Gestión documental | documentos, carpetas, cuota | **Servicio crítico**: consulta intensiva y constante; es el que se escala (3 réplicas) |
| ms-autenticacion | 1.6 Integración MinTIC | intentos de autenticación | Depende de GovCarpeta, que puede tardar ~30 s o caerse: aislarlo evita que arrastre a la carga y la consulta |
| ms-interoperabilidad | 1.3 Interoperabilidad | transferencias, directorio de operadores | Expone endpoints públicos a otros operadores y habla con sistemas ajenos |
| ms-notificaciones | 1.5 Notificaciones | avisos enviados | Depende de un proveedor de correo/SMS externo; nunca debe bloquear una operación |
| ms-comparticion | 1.4 Compartición | entidades, paquetes | Actor distinto (entidades) con su propia autenticación (ADR-07) |
| ms-analitica | 1.7 y 1.8 Analítica y Premium | métricas, casos PQRS | Servicio de valor agregado: si falla, nada básico se afecta |

**Por qué no más fino.** Por ejemplo, un servicio de cuota aparte de documentos: la cuota y el documento cambian juntos y deben ser **atómicos**. Separarlos obligaría a una transacción distribuida por cada carga, con un costo desproporcionado (nanoservicios).

**Por qué no más grueso.** Por ejemplo, identidad y documentos juntos: tienen perfiles de carga distintos y documentos debe escalar sin arrastrar el resto. Y si autenticación viviera dentro de documentos, una caída de GovCarpeta bloquearía la consulta, que es justo lo que la matriz prohíbe.

**Respecto al documento (ADR-01).** ADR-01 nombra 6 servicios para la Entrega 2. Compartición y analítica entraron después, como prevé su propio supuesto: los dominios nuevos se incorporan como servicios adicionales sin modificar los existentes.

---

## 5. Decisiones de arquitectura y tecnologías (por qué)

| Decisión | Alternativas descartadas | Por qué |
|---|---|---|
| **ADR-01 Microservicios con base por servicio** | Monolito modular; servicios con base compartida | La fuerza dominante es el **aislamiento de fallas** (sección 3 lo demuestra). La base por servicio da autonomía de datos y escalamiento diferenciado. Costo: complejidad operativa y consistencia eventual. |
| **ADR-02 Nube gestionada (objetivo) / Docker Compose local (curso)** | Infraestructura propia; híbrido | En el curso se despliega en local con autorización del docente. Las mismas imágenes de contenedor y el almacenamiento S3 portable permiten pasar a Kubernetes sin rediseñar. |
| **ADR-03 Persistencia: MongoDB en todos (objetivo políglota con PostgreSQL)** | Un único motor relacional | La razón de PostgreSQL era garantizar en el motor la unicidad de la dirección única; se cumple con **índices únicos** e `immutable` en MongoDB. Las transacciones se reemplazaron por escrituras **atómicas condicionales** (por ejemplo, la reserva de cuota). Un solo motor simplifica la operación. |
| **ADR-04 Eventos + saga orquestada** | Llamadas síncronas encadenadas; 2PC | El registro toca Registraduría, GovCarpeta, la base y otros servicios. La saga persiste en *pendiente*, confirma con GovCarpeta y compensa con `unregisterCitizen`. Todo lo que no es camino crítico va por **RabbitMQ**, con reintentos con retroceso exponencial, cola de fallidos y consumidores idempotentes. |
| **ADR-05 Node.js + Express, RabbitMQ, S3 (MinIO)** | Java/Spring; Kafka | La carga está dominada por la **espera de red** (GovCarpeta, otros operadores), que es justo donde el modelo no bloqueante de Node rinde. RabbitMQ trae reintentos y colas de fallidos nativos; Kafka es más complejo de operar y el volumen no lo justifica. S3 es portable entre proveedores. |
| **ADR-06 Seguridad** | MFA para todo; solo usuario y contraseña | JWT de 15 min validado **en cada servicio** (no solo en el gateway); Argon2id para contraseñas; bloqueo tras 5 intentos; **URLs prefirmadas** (al centralizador se le envía un enlace de 15 min, nunca el archivo: RNF-13 y RNF-14); **autenticación escalonada**: enviar documentos a un tercero, autorizar una solicitud o cambiar de operador exigen confirmar la contraseña. |
| **ADR-07 Autenticación institucional separada** | Mismo token para todos | Ciudadanos y entidades usan llaves y emisores distintos: un token de un tipo nunca abre rutas del otro. |

**Tácticas de calidad, en una frase cada una (para preguntas):**
- **Disponibilidad:**
  - réplicas del servicio crítico;
  - colas durables;
  - reconexión automática al bus;
  - reconciliadores que reenvían lo pendiente;
  - cortacircuitos y plazos en el gateway;
  - verificación de salud (`/health`, `/ready`) por servicio.
- **Escalabilidad:** servicios sin estado detrás del gateway; HT-03 midió **0 % de errores a 100 req/s** con 1 y 3 réplicas, p95 ≈ 9 ms, y el reparto entre 3 réplicas fue ~33 % cada una.
- **Seguridad:**
  - validación del token en profundidad;
  - control de dueño en cada recurso;
  - bitácora de accesos (RF-39);
  - escáner de secretos en el CI.
- **Interoperabilidad:**
  - contrato verificado contra el Swagger de GovCarpeta;
  - suite de pruebas de contrato del protocolo de transferencia (HT-05).
- **Mantenibilidad:**
  - CI por servicio;
  - más de 1.800 pruebas automatizadas;
  - pruebas de mutación de las protecciones críticas;
  - trazabilidad distribuida con `x-trace-id`.

---

## 6. Preguntas probables y respuesta corta

- **¿Por qué no un monolito si es un proyecto académico?** Porque el caso exige que la falla de una funcionalidad no tumbe a las demás, y eso se demuestra en vivo (sección 3). Un monolito cae entero.
- **¿Cómo mantienen la consistencia sin transacciones distribuidas?** Con una saga con compensación, consistencia eventual, consumidores idempotentes (al menos una vez) y reconciliadores que reintentan lo que quedó a medias.
- **¿Qué pasa si GovCarpeta está caído?** No se puede registrar ni certificar. Se reintenta con espera creciente y la autenticación vuelve a *temporal* con aviso al ciudadano. Login, carga, consulta y descarga siguen funcionando.
- **¿El gateway no es un punto único de falla?** Sí, en local. En producción va con réplicas detrás del balanceador de la plataforma. Es una pieza sin estado y por eso se puede replicar.
- **¿Por qué MongoDB si el documento decía PostgreSQL?** Ver ADR-03 arriba. Está documentado como nota de alcance en el documento y en el README.
- **¿Cómo protegen el archivo que se envía a GovCarpeta?** Con una URL prefirmada de 15 minutos con firma HMAC: si se altera un carácter, el almacenamiento responde `403`. Se demuestra en la página con el botón *Descargar* (la descarga del ciudadano vale 1 h).
- **¿Una sola instancia de MongoDB no rompe "base por servicio"?** Cada servicio tiene su **propia base lógica** y ninguno accede a la de otro. Compartir el proceso de Mongo es una simplificación del despliegue local; en producción serían bases gestionadas separadas.

---

## 7. Límites conocidos (decirlos antes de que los pregunten)

- **Despliegue:** es local con Docker Compose, con una sola instancia de MongoDB, RabbitMQ y gateway. El mTLS interno está implementado pero desactivado en local.
- **Registraduría:** está simulada (no hay servicio real accesible). La "firma" de la cédula es una huella SHA-256.
- **HU-07.3 (solicitud documental multioperador):** está parcial, porque falta el protocolo con otros operadores.
- **Cliente:** no hay aplicación cliente de producción. `demo-web/` es un cliente de demostración.
- **Metas numéricas** (99,5 % de disponibilidad, un millón de carpetas): son objetivos de diseño. En local solo se demuestran en parte, con HT-03 y la prueba de degradación.
