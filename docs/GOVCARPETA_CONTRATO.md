# Contrato real de GovCarpeta

Verificado contra el Swagger real: https://govcarpeta-apis-4905ff3c005b.herokuapp.com/api-docs/ (2026-09-17).
No son suposiciones — son los campos exactos que el servidor espera y devuelve.

**Nota de disponibilidad:** el host a veces falla resolución DNS de forma intermitente (Heroku free-tier-like). Si un `fetch`/`curl` falla con DNS error, reintentar — no asumir que la API cambió de URL.

## GET /apis/validateCitizen/{id}

- Path param `id`: number
- Respuestas: `200 OK`, `204 Not Content`, `500`, `501`
- ✅ **Verificado empíricamente el 2026-09-17** contra el sandbox real: un documento (`987654321099`) que nunca ha sido usado por nadie devuelve **204**. Como un documento jamás registrado no puede estar "ya afiliado", esto confirma **204 = disponible para registrar**. `200` probablemente significa "ya existe", pero eso último aún no se confirmó con un caso real conocido (solo se dedujo por descarte). Configurable vía `GOVCARPETA_AVAILABLE_STATUS` sin tocar código si el comportamiento cambia.

## POST /apis/registerCitizen

Body (todos requeridos):
```json
{
  "id": 1234567890,
  "name": "Carlos Andres Caro",
  "address": "Cra 54 # 45 -67",
  "email": "caro@mymail.com",
  "operatorId": "65ca0a00d833e984e2608756",
  "operatorName": "Operador Ciudadano"
}
```
- `id` es **number**, no string.
- `operatorId`/`operatorName` son los de **nuestro propio operador** (obtenidos con `POST /apis/registerOperator`, ver HU-11) — hay que tenerlos en configuración antes de poder registrar cualquier ciudadano.
- Respuestas: `201 Created`, `500`, `501` (ya registrado).

## DELETE /apis/unregisterCitizen (compensación de la saga)

```json
{ "id": 1234567890, "operatorId": "...", "operatorName": "..." }
```
- Respuestas: `201 Deleted`, `204 Not Content`, `500`, `501`.

## PUT /apis/authenticateDocument

```json
{
  "idCitizen": 1234567890,
  "UrlDocument": "https://<bucket>.s3.amazonaws.com/...",
  "documentTitle": "Diploma Grado"
}
```
- El campo es `UrlDocument` con **U mayúscula**, no `urlDocument`.
- Respuesta `200`: **string plano** (ej. "El documento: Diploma Grado del ciudadano 1234567890 ha sido autenticado exitosamente"), no JSON estructurado.
- Otras respuestas: `204`, `500`, `501`.

## POST /apis/registerOperator

⚠️ **Inconsistencia real del Swagger** (no es un error nuestro): el arreglo `required` del schema dice `["nameOperator", "adress", "contactMail", "participants"]`, pero las `properties` definen `name`, `address`, `contactMail`, `participants` (nombres distintos).

```json
{
  "name": "Operador Ciudadano",
  "address": "Cra 34 # 35 -67",
  "contactMail": "info@operador123.com",
  "participants": ["Julian Giraldo Chica", "Jennifer Andrea Lopez Gomez", "Tomas Echavarria Gil"]
}
```
- Respuesta `201`: **string plano** que ES el `operatorId` (ej. `"65ca0a00d833e984e2608756"`), no un objeto. El cliente acepta también el id entre comillas o dentro de `{_id}`/`{operatorId}`.
- **Es un registro permanente en un directorio COMPARTIDO** por todos los equipos del curso (71 operadores al 2026-09-19) y **no existe endpoint para borrarlo**. Un `POST` repetido crea otro operador. Por eso `HU-11` no reintenta nunca este llamado y antes de enviarlo comprueba que el nombre no exista.
- **Estrategia ante la inconsistencia**: por defecto el cliente envía **ambos** juegos de nombres (`name`+`nameOperator`, `address`+`adress`). Si el servidor rechazara los campos extra (501), `--payload-style=properties|required` envía solo uno. **Confirmado con el primer registro real (2026-09-19)**: el servidor aceptó ambos juegos de campos; ver el resultado en el punto siguiente.
- **Primer `POST` real (2026-09-19, payload `union` por defecto):** el servidor **aceptó** los campos de ambos juegos de nombres y **creó** el operador (queda una sola entrada en el directorio, con `name` en `operatorName` y los participantes). Pero la respuesta **no se pudo interpretar como el `operatorId`** con el formato documentado arriba (texto plano, entre comillas u objeto), y el script recuperó el id buscando el nombre en `getOperators`. No se guardó la respuesta cruda, así que **no sabemos aún** qué devolvió exactamente (¿201 con otro formato?, ¿otro código?). Si HU-05b u otra historia vuelve a llamar a un `POST` de este tipo, conviene registrar la respuesta cruda antes de asumir el formato.
- Ver `docs/OPERADOR_MINTIC.md` para el procedimiento.

## PUT /apis/registerTransferEndPoint

```json
{
  "idOperator": "65ca0a00d833e984e2608756",
  "endPoint": "http://mioperador.com/api/transferCitizen",
  "endPointConfirm": "http://mioperador.com/api/transferCitizenConfirm"
}
```
- Solo `idOperator` y `endPoint` son estrictamente requeridos, pero `endPointConfirm` es indispensable para el protocolo de dos fases acordado con los otros equipos del curso.
- Respuestas: `201 Updated`, `500`, `501`.
- **El Gherkin de HU-05b está desactualizado**: decía `{operatorId, transferEndpoint}` y `200`; el contrato verificado (este) es `{idOperator, endPoint, endPointConfirm}` y `201`. El cliente envía exactamente estos tres campos y acepta 200 o 201.
- Es una **actualización** (reemplaza los valores de nuestro operador), no un alta: repetirla con los mismos datos deja el mismo resultado, así que el cliente reintenta ante 500/red (a diferencia de `registerOperator`).
- El directorio (`getOperators`) solo refleja `transferAPIURL` (el `endPoint`), no el `endPointConfirm`; con eso se detecta "ya publicado" y se verifica una publicación.
- ⚠️ **El `PUT` real todavía no se ha ejecutado** (no hay endpoint en línea que publicar): lo verificado contra el sandbox real es la simulación (solo `GET`), no el `PUT`.

## GET /apis/getOperators

Respuesta `200` (lista). **El sandbox real NO coincide con el Swagger** (verificado el 2026-09-19 sobre 71 operadores):

| | Swagger dice | Sandbox real |
|---|---|---|
| id | `OperatorId` | **`_id`** (siempre, 24 caracteres) |
| nombre | `OperatorName` | **`operatorName`** |
| integrantes | (no aparece) | `participants` |
| URL de transferencia | `transferAPIURL` | `transferAPIURL`, **solo en 16 de 71** y a veces con un **espacio inicial** (`" http://..."`) |

```json
[
  { "_id": "690d4e0e8502c8000221a5a7", "operatorName": "Carpeta Ciudadana", "participants": ["..."], "transferAPIURL": " http://..." }
]
```
**Estado real al 2026-09-19 (HU-05a):** 73 operadores, 16 con dirección de transferencia (1 con una IP privada) y nombres repetidos ("Operador 123" ×10). `ms-interoperabilidad` lo consume con su propio cliente de solo lectura. El cliente (`listOperators`) normaliza ambas formas a `{id, name, transferApiUrl, participants}`, recorta espacios y descarta entradas sin id. HU-05a puede reutilizarlo.

- Sigue habiendo diferencia de casing respecto a lo que se **envía** en `registerCitizen`/`unregisterCitizen` (`operatorId`/`operatorName`).

## Lo que GovCarpeta NO expone

`transferCitizen` y `transferCitizenConfirm` los implementa **cada operador** (peer-to-peer). GovCarpeta solo guarda las URLs (`endPoint`/`endPointConfirm`) y las expone en el directorio (`getOperators`).
