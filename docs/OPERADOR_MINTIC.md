# Registro del operador en MinTIC (HU-11, RF-34)

`registerCitizen`, `authenticateDocument` y `registerTransferEndPoint` exigen el **`operatorId`** de nuestro operador. Sin él, HU-01 y HU-04 no se pueden probar contra GovCarpeta real (el servicio lo avisa al arrancar). Este procedimiento lo obtiene.

## ⚠️ Antes de empezar

- El directorio de GovCarpeta es **compartido por todos los equipos** y **no permite borrar**. Cada registro es permanente y visible para todos, y **incluye los nombres de los integrantes**.
- Un `POST` repetido crea un operador duplicado. El script **nunca reintenta** el registro y, antes de enviarlo, comprueba que el nombre no exista.
- **Lo registra UNA persona por equipo** y comparte el `operatorId` con las demás (no es un secreto, pero tampoco se hardcodea en el código).
- **Una vez por operador, no por máquina.** El issue pide "una vez por ambiente", pero dev/staging/prod comparten el mismo sandbox: registrar uno distinto por ambiente multiplica registros permanentes. Recomendado: **un operador para todo el equipo**, y el mismo `OPERATOR_ID` en cada ambiente, salvo que se necesite de verdad separarlos.

## Pasos

1. Definir los datos en `services/ms-identidad/.env` (ver `.env.example`):
   `OPERATOR_NAME` (único en el directorio), `OPERATOR_ADDRESS`, `OPERATOR_CONTACT_MAIL`, `OPERATOR_PARTICIPANTS` (separados por coma).
2. **Simulación** (no envía nada, pero sí consulta el directorio para detectar duplicados):
   ```bash
   cd services/ms-identidad
   npm run register:operator
   ```
3. Registrar de verdad, guardando el id en `.env`:
   ```bash
   npm run register:operator -- --confirm --write-env
   ```
4. Compartir el `OPERATOR_ID` con el equipo. Cada quien lo pone en su `.env`; en ambientes desplegados va como **variable de entorno / secreto de la plataforma**, no en el repo.

## Resultados posibles

| Código de salida | Significado |
|---|---|
| 0 | Registrado (o recuperado del directorio si la respuesta se perdió). Imprime `OPERATOR_ID=...` |
| 2 | Datos inválidos. No se envió nada |
| 3 | Ya existe: `OPERATOR_ID` ya configurado, o el nombre ya está en el directorio (indica el id). No se envió nada |
| 1 | Error. Si GovCarpeta responde `501`, probar `--payload-style=properties` o `--payload-style=required` (el Swagger es inconsistente con los nombres de campo) |

Si el registro falla sin confirmarse (timeout, 500), **no lo repitas a ciegas**: el script ya revisa el directorio y, si el operador quedó creado, lo recupera y muestra su id. Si aun así hay duda, busca el nombre en `GET /apis/getOperators`.

## Después del registro

- `OPERATOR_ID` en el `.env` de cada integrante → `registerCitizen` (HU-01) funciona contra el GovCarpeta real.
- HU-05b (publicar `endPoint`/`endPointConfirm`) usa este mismo `operatorId`.
