# Contrato real de GovCarpeta

Verificado contra el Swagger real: https://govcarpeta-apis-4905ff3c005b.herokuapp.com/api-docs/ (2026-09-17).
No son suposiciones — son los campos exactos que el servidor espera y devuelve.

**Nota de disponibilidad:** el host a veces falla resolución DNS de forma intermitente (Heroku free-tier-like). Si un `fetch`/`curl` falla con DNS error, reintentar — no asumir que la API cambió de URL.

## GET /apis/validateCitizen/{id}

- Path param `id`: number
- Respuestas: `200 OK`, `204 Not Content`, `500`, `501`
- ⚠️ El Swagger NO documenta el significado exacto de 200 vs 204 (no hay schema de respuesta ni body). **Verificar empíricamente contra el sandbox antes de codificar la lógica de la saga**: probar con un id que no existe en ningún operador y ver qué status devuelve realmente.

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

⚠️ **Inconsistencia real del Swagger** (no es un error nuestro): el arreglo `required` del schema dice `["nameOperator", "adress", "contactMail", "participants"]`, pero las `properties` definen `name`, `address`, `contactMail`, `participants` (nombres distintos). **Probar empíricamente** contra el sandbox antes de automatizar.

```json
{
  "name": "Operador Ciudadano",
  "address": "Cra 34 # 35 -67",
  "contactMail": "info@operador123.com",
  "participants": ["Julian Giraldo Chica", "Jennifer Andrea Lopez Gomez", "Tomas Echavarria Gil"]
}
```
- Respuesta `201`: **string plano** que ES el `operatorId` directamente (ej. `"65ca0a00d833e984e2608756"`), NO un objeto `{operatorId: ...}`.

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

## GET /apis/getOperators

Respuesta `200`:
```json
[
  { "OperatorId": "65ca0a00d833e984e2608756", "OperatorName": "Operador 123", "transferAPIURL": "http://mioperador.com/api/transferCitizen" }
]
```
- ⚠️ **Inconsistencia real de casing**: aquí viene `OperatorId`/`OperatorName` (O mayúscula), pero se **envía** como `operatorId`/`operatorName` (o minúscula) en registerCitizen/unregisterCitizen. Comparar case-insensitive o normalizar al parsear.
- El campo de URL se llama `transferAPIURL`, no `transferEndpoint`.

## Lo que GovCarpeta NO expone

`transferCitizen` y `transferCitizenConfirm` los implementa **cada operador** (peer-to-peer). GovCarpeta solo guarda las URLs (`endPoint`/`endPointConfirm`) y las expone en el directorio (`getOperators`).
