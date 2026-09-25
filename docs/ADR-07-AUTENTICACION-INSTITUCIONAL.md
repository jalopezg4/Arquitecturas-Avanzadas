# ADR-07: La autenticación de instituciones pertenece a `ms-comparticion`

**Estado:** aceptada · **Fecha:** 2026-09-23 · **Decide:** Julián Giraldo Chica (Fase 2) · **Consultado:** equipo MiFolio

> Las ADR-01 a ADR-06 viven en el expediente del curso (`Arquitectura_Carpeta_Ciudadana.docx`). Esta es la primera
> ADR escrita dentro del repositorio, porque nace de una necesidad que apareció programando HU-10 y HU-06.3 y que
> ninguna historia del backlog cubría.

## Contexto

Dos historias de la Fase 2 necesitan que una **entidad institucional** actúe contra el sistema:

- **HU-10** (RF-11): una entidad emisora envía un documento ya certificado a la carpeta de un ciudadano. Su criterio
  de aceptación dice literalmente: *"la entidad emisora se autentica con sus propias credenciales (no las del ciudadano)"*.
- **HU-06.3** (RF-27/28/29): una entidad receptora solicita documentos a un ciudadano, que luego autoriza.

El sistema, antes de esta decisión, solo sabía autenticar **ciudadanos**:

- `ms-identidad` es el único emisor de JWT (`AuthService`, HS256 con `kid`, llavero rotable de HT-07).
- `ms-gateway`, `ms-identidad` y `ms-documentos` verifican con la **misma llave simétrica** (`JWT_SECRET`) y con el
  mismo criterio: `typ === "access"`, `iss === "ms-identidad"`, `sub` presente → `req.auth.ciudadanoId = sub`.
- `ms-comparticion` (dueño de la entidad `Institution` desde HU-06.1) no tenía `security/`, ni `jsonwebtoken`, ni `argon2`.
- La única credencial parecida era `REGISTRATION_TOKEN`: **un solo secreto global**, igual para todas las entidades,
  que no identifica a ninguna.

## Alternativas consideradas

| # | Alternativa | Por qué no se eligió |
|---|---|---|
| A | `ms-identidad` emite también tokens de entidad | Obliga a sincronizar el alta de credenciales entre `ms-comparticion` (dueño del dato) y `ms-identidad`, y a tocar HU-06.1 ya mergeada. Dos fuentes de verdad sobre "quién es esta entidad". Sigue siendo la mejor opción **si algún día se pasa a RS256**, donde un único emisor con la clave privada es claramente superior |
| B | **`ms-comparticion` emite el token de entidad** (elegida) | Ver abajo |
| C | API key opaca por institución, con introspección desde `ms-documentos` | Pone a `ms-documentos` —el servicio crítico, 3 réplicas— a depender de `ms-comparticion` en el camino de una carga. Contradice la matriz de degradación de `ARQUITECTURA.md` y el JWT autocontenido de ADR-01 |
| D | mTLS con certificado de cliente por entidad | El mecanismo ya existe (HT-07) y es el más fuerte, pero en las plataformas del curso el gateway no ve el certificado del cliente, y operar una CA (emisión, caducidad, revocación) excede el alcance de la Fase 2 |

## Decisión

> **La autenticación de ciudadanos pertenece a `ms-identidad`, mientras que la autenticación de instituciones
> pertenece a `ms-comparticion`. Cada tipo de actor utiliza un JWT independiente y un secreto criptográfico
> independiente.**

Concretamente:

| | Ciudadano | Entidad |
|---|---|---|
| Emisor | `ms-identidad` | `ms-comparticion` |
| Endpoint | `POST /api/v1/auth/login` | `POST /api/v1/institutions/auth/token` |
| Credencial | documento + contraseña | NIT + contraseña |
| Llave | `JWT_SECRET` | **`ENTITY_JWT_SECRET`** |
| `iss` | `ms-identidad` | `ms-comparticion` |
| `act` | *(ausente)* | `entidad` |
| `sub` | `ciudadanoId` | `institutionId` |
| Refresh token | sí (rotación de un solo uso) | **no** (cliente máquina) |
| Middleware | `requireAuth` → `req.auth.ciudadanoId` | `requireEntityAuth` → `req.auth.institutionId` |

Lo que **no** cambia: el hash es Argon2id en ambos (ADR-06); el algoritmo sigue fijado a HS256 con `kid` y el mismo
llavero rotable en tres fases (HT-07); el access token vive como máximo 15 minutos; cada microservicio revalida el
token por su cuenta y el gateway sigue siendo la primera barrera, no la única (ADR-06).

## Por qué B

1. **La credencial vive junto al dato que identifica.** `ms-comparticion` ya es dueño exclusivo de `Institution`
   (ADR-01). No hay nada que sincronizar entre servicios ni riesgo de credenciales huérfanas.
2. **HU-06.3 iba a necesitar el llavero de todos modos** (el ciudadano autoriza dentro de este servicio), así que
   el salto de "verificar" a "también firmar" es pequeño.
3. **La separación se apoya en un chequeo que ya existía.** Un token institucional falla en `requireAuth` por dos
   caminos independientes: su `kid` no está en el llavero de ciudadanos (otra llave) **y** su `iss` no coincide.
   No depende de una validación nueva que alguien pueda olvidar al agregar la ruta número doce.
4. **No toca código ya mergeado de otro integrante** más allá de lo imprescindible.

## Consecuencias

**A favor**

- Una entidad comprometida no puede emitir tokens de ciudadano: no conoce `JWT_SECRET`.
- `ms-identidad` no gana responsabilidades nuevas ni depende de `ms-comparticion`.
- `AuditEntry` ya soportaba `actorType: "entidad"` y `delegated`: la auditoría no necesitó cambios de modelo.

**En contra, y asumido**

- **Hay dos emisores de tokens.** Cada servicio que valide debe saber qué emisor vale para qué ruta. Se mitiga
  marcando el actor en la tabla de rutas del gateway (`actor: "entidad"`), no en el token: *la ruta decide qué
  tipo de actor acepta, no el token*.
- **Dos llaves que rotar** en vez de una, con el mismo procedimiento de tres fases.
- El validador de configuración **rechaza arrancar si `ENTITY_JWT_SECRET` es igual a `JWT_SECRET`**, en cualquier
  ambiente: si fueran la misma, toda esta separación sería decorativa.

## Decisiones asociadas (documentadas a propósito)

1. **`verificada` NO condiciona la autenticación** (ver la sección siguiente, que completa esta decisión). Se trata
   como comprobación de **autorización**: el token lleva el claim `ver` y son HU-10 y HU-06.3 quienes lo exigen.
2. **La contraseña se fija al registrarse y es opcional.** Opcional porque el contrato de HU-06.1, ya mergeado,
   responde exactamente `{institutionId}` y no admite devolver un `clientId`; una entidad registrada sin contraseña
   simplemente no puede autenticarse. **No existe todavía** forma de asignar o rotar la credencial de una entidad ya
   registrada: queda para cuando el equipo decida el proceso de verificación.
3. **El identificador de login es el NIT**, no un `clientId` nuevo: ya es único, ya está validado con su dígito de
   verificación y ya se normaliza (`parseNit`). El NIT no es un secreto; el secreto es la contraseña.
4. **Sin refresh token para entidades.** Un cliente máquina vuelve a autenticarse; menos superficie que mantener.

## Verificación institucional (ampliación aceptada el 2026-09-23)

> **La autenticación institucional y la verificación institucional son conceptos independientes. Una institución no
> verificada puede autenticarse, pero no puede ejecutar operaciones institucionales sensibles.**

> **La verificación institucional representa una decisión humana registrada por el operador del sistema. No
> constituye una verificación automática de existencia jurídica contra una fuente externa.**

Lo segundo no es una limitación que se elija: **no existe fuente externa que consultar**. GovCarpeta solo conoce
ciudadanos y operadores (`GOVCARPETA_CONTRATO.md`), el RUES y la DIAN están fuera del alcance del curso, y el dígito
de verificación del NIT es aritmética, no existencia. Lo máximo defendible es registrar quién decidió, cuándo y con
qué evidencia.

### Mecanismo elegido: operación administrativa fuera de banda (CLI)

`npm run verify:institution` en `ms-comparticion`, siguiendo el patrón de `register-operator.js` (HU-11) y
`publish-endpoint.js` (HU-05b): simulación por defecto, `--confirm` para actuar, códigos de salida documentados.

```bash
npm run verify:institution -- --nit=890901389                                    # simula, no escribe
npm run verify:institution -- --nit=890901389 --confirm --motivo="..."           # verifica
npm run verify:institution -- --nit=890901389 --revoke --confirm --motivo="..."  # revoca
```

Se descartaron: una **ruta HTTP administrativa** (superficie nueva y un secreto global más, con la tentación de
exponerla en el gateway) y **reutilizar `REGISTRATION_TOKEN`** como prueba de afiliación (fundiría dos poderes
distintos en un secreto y eliminaría el momento de revisión humana).

**Por qué un script y no una ruta:** el gateway solo enruta lo declarado en su lista blanca, así que un script **no
es alcanzable desde fuera por construcción**, y ejecutarlo exige acceso al despliegue. Una entidad no puede
verificarse a sí misma. A eso se suman las defensas que ya existían: `register()` ignora `verificada` del cuerpo
(protección contra *mass assignment*, probada) y `requireEntityAuth` nunca autoriza esta operación.

### Reglas

- **La lógica vive en `InstitutionService`** (`verify()` / `revokeVerification()`); el script es solo otra interfaz,
  como lo es un controlador HTTP.
- **Idempotente:** el cambio de estado es una escritura condicional y atómica. Si ya estaba en ese estado no se
  escribe nada y la operación sale con código `3`, sin pisar la decisión original.
- **Trazabilidad:** `verificadaEn`, `verificadaPor` y `motivoVerificacion` en el documento (última decisión) y la
  historia completa en `audit_logs` (append-only). El motivo es **obligatorio** al confirmar: es la evidencia.
- **Auditoría con `actorType: "sistema"`** — el valor que el enum de `AuditEntry` declaraba y nunca se había usado —
  con acciones `institucion.verificar` e `institucion.revocar_verificacion`. El actor es el responsable humano.
- **Autorización en la operación, no en el login:** `requireEntityAuth` (401 si no eres una entidad) →
  `requireVerifiedEntity` (**403** si no estás verificada). Es 403 y no 401 a propósito: la credencial es válida y
  se reconoció a la entidad; lo que falta es autorización, y volver a autenticarse no lo arregla.

### Ventana de propagación, aceptada explícitamente

`requireVerifiedEntity` lee el claim `ver` del token, **no consulta a `ms-comparticion`**: una llamada síncrona
acoplaría el servicio crítico al de compartición, que es justo lo que evita la matriz de degradación de
`ARQUITECTURA.md`. El precio: **una revocación tarda hasta 15 minutos** (la vigencia del token) en surtir efecto en
`ms-documentos`. Es inmediata en `ms-comparticion`, que lee su propia base. Si el equipo quisiera acortarla, la
palanca es `ENTITY_ACCESS_EXPIRES_IN` (configuración), no un cambio de arquitectura.

## Consumidor del claim `ver`: HU-10 (2026-09-23)

`POST /api/v1/documents/inbound` en `ms-documentos` es la **primera ruta** que exige un token institucional y la
primera que usa el claim `ver`, a través de `requireEntityAuth` → `requireVerifiedEntity`. Con ella:

- `ENTITY_JWT_SECRET` deja de ser opcional *de hecho* en `ms-documentos` y en el gateway: sin la llave, esa ruta
  responde `401` y el resto del servicio sigue igual.
- La ventana de propagación descrita arriba se materializa: **revocar una verificación tarda hasta 15 minutos** en
  surtir efecto sobre esta ruta, porque se lee del token y no se consulta a `ms-comparticion`.
- La entrega se audita con `delegated: true` y **no** aparece como violación en `verifyNoOutOfPolicyAccess()`.

### Nota sobre el formato de la dirección única

El criterio de aceptación de HU-10 la escribe simplificada como `documento@carpetacolombia.co`. El formato **real**
que genera `ms-identidad` (`CitizenSagaService._buildDireccionUnica`) es:

```
<documento>-<8 hex aleatorios>@carpetacolombia.co      ej. 1000000001-3f9c2ab7@carpetacolombia.co
```

**El requisito original no se modifica** (la HU y `PLAN_TRABAJO.md` quedan como están): esto se documenta aquí, que
es donde vive la decisión técnica. El sufijo aleatorio no es un detalle cosmético — es lo que hace que la dirección
**no sea adivinable a partir de la cédula**, y por eso el rechazo de una dirección inexistente no se considera un
vector de enumeración práctico. La validación en `ms-documentos` comprueba solo que sea una dirección de correo
plausible, no el formato exacto: atar el formato aquí haría que un cambio en `ms-identidad` rompiera la recepción
en silencio.

## Estado de la implementación

Implementadas **la autenticación** (credencial, endpoint de login, token institucional, middleware y distinción en
el gateway) y **la verificación** (CLI, trazabilidad, auditoría como `sistema`, `requireVerifiedEntity`), con pruebas.

**HU-10 y HU-06.3 no están implementadas.** Concretamente: `ms-documentos` tiene `requireEntityAuth` y
`requireVerifiedEntity` listos pero **ninguna ruta montada con ellos**; la tabla de rutas del gateway todavía no
declara ninguna ruta `actor: "entidad"` (la capacidad está probada con una tabla inyectada en los tests).

**Pendiente del equipo, no de esta ADR:**

- `hasInstitutionalFolder()` (HU-06.2, otro integrante) **no mira `verificada` y se dejó así a propósito**. Con esta
  ADR una entidad puede tener carpeta activa y no estar verificada; hay que decidir si, para entregar un paquete
  documental, eso cuenta como "tiene carpeta" (entrega interna) o debe caer al envío por correo (RF-26).
- `REGISTRATION_TOKEN` sigue siendo **opcional**: su comportamiento no se cambió. Debería exigirse en cualquier
  ambiente desplegado (ver `SEGURIDAD.md`, sección 10).

## Referencias

- `docs/SEGURIDAD.md`, sección 12 (detalle operativo) y sección 10 (registro autodeclarado)
- `docs/ARQUITECTURA.md` (mapa de servicios), `docs/HISTORIAS_DE_USUARIO.md` (HU-10, HU-06.3)
- ADR-01 (microservicios, base por servicio), ADR-06 (seguridad), HT-07 (secretos y rotación)
