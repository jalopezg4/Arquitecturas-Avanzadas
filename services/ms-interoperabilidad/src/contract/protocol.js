/**
 * HT-05: el contrato de transferencia ACORDADO entre los equipos del curso, escrito como validadores. Es la unica
 * fuente de verdad que usan la suite de contrato, el operador de referencia y las pruebas de nuestra propia
 * implementacion (ver docs/SEGURIDAD.md, seccion 14).
 *
 *   POST {base}/api/transferCitizen         {id: number, citizenName, citizenEmail, urlDocuments: {K: [url, ...]}, confirmAPI}
 *   POST {confirmAPI} (transferCitizenConfirm) {id: number, req_status: 1 | 0}
 *
 * Cada validador devuelve la LISTA de incumplimientos (vacia = cumple): un reporte que diga que fallo, no solo que fallo.
 */

const TRANSFER_PATH = "/api/transferCitizen";
const CONFIRM_PATH = "/api/transferCitizenConfirm";
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function isHttpUrl(value) {
  if (typeof value !== "string" || !value || /\s/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const isCedula = (v) => Number.isSafeInteger(v) && v > 0;

function validateTransferCitizen(body) {
  const problems = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["el cuerpo debe ser un objeto JSON"];
  if (!isCedula(body.id)) problems.push("id debe ser un numero entero positivo (la cedula), no texto");
  if (typeof body.citizenName !== "string" || !body.citizenName.trim()) problems.push("citizenName debe ser un texto no vacio");
  if (typeof body.citizenEmail !== "string" || !EMAIL_RE.test(body.citizenEmail)) problems.push("citizenEmail debe ser un correo valido");
  if (!body.urlDocuments || typeof body.urlDocuments !== "object" || Array.isArray(body.urlDocuments)) {
    problems.push("urlDocuments debe ser un objeto {clave: [url, ...]}");
  } else {
    for (const [key, value] of Object.entries(body.urlDocuments)) {
      if (!Array.isArray(value) || value.length === 0) problems.push(`urlDocuments.${key} debe ser una lista no vacia de URLs`);
      else if (!value.every(isHttpUrl)) problems.push(`urlDocuments.${key} contiene algo que no es una URL http(s)`);
    }
  }
  if (!isHttpUrl(body.confirmAPI)) problems.push("confirmAPI debe ser una URL http(s)");
  return problems;
}

function validateConfirm(body, { expectedId } = {}) {
  const problems = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["el cuerpo de la confirmacion debe ser un objeto JSON"];
  if (!isCedula(body.id)) problems.push("id debe ser un numero entero positivo (la cedula), no texto");
  else if (expectedId !== undefined && body.id !== expectedId) problems.push(`id debe ser el del ciudadano transferido (${expectedId}), llego ${body.id}`);
  if (body.req_status !== 0 && body.req_status !== 1) problems.push(`req_status debe ser el numero 1 (exito) o 0 (fracaso), llego ${JSON.stringify(body.req_status)}`);
  return problems;
}

module.exports = { TRANSFER_PATH, CONFIRM_PATH, validateTransferCitizen, validateConfirm, isHttpUrl };
