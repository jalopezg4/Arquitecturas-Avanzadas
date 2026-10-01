/**
 * NIT colombiano: numero base (sin puntos) + digito de verificacion (DV, modulo 11 de la DIAN).
 * Se acepta con o sin puntos y con o sin DV ("890.901.389-5", "890901389-5", "890901389"). Si trae DV, debe ser correcto.
 */

const WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]; // de derecha a izquierda

/** Digito de verificacion del NIT base (solo digitos, hasta 15). */
function checkDigit(base) {
  let sum = 0;
  const digits = base.split("").reverse();
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * WEIGHTS[i];
  const r = sum % 11;
  return String(r > 1 ? 11 - r : r);
}

/**
 * @returns {{ok: true, nit: string, dv: string} | {ok: false, reason: string}}
 */
function parseNit(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "el NIT es obligatorio" };
  const text = raw.trim();
  if (!/^[0-9.]+(-[0-9])?$/.test(text)) return { ok: false, reason: "el NIT solo puede llevar digitos, puntos y un guion antes del digito de verificacion" };
  const [basePart, dvPart] = text.split("-");
  if (/\.\./.test(basePart) || basePart.startsWith(".") || basePart.endsWith(".")) return { ok: false, reason: "el NIT tiene puntos mal ubicados" };
  const base = basePart.replace(/\./g, "");
  if (base.length < 6 || base.length > 12) return { ok: false, reason: "el NIT debe tener entre 6 y 12 digitos (sin el digito de verificacion)" };
  if (/^0+$/.test(base)) return { ok: false, reason: "el NIT no es valido" };
  const dv = checkDigit(base);
  if (dvPart !== undefined && dvPart !== dv) return { ok: false, reason: "el digito de verificacion del NIT no coincide" };
  return { ok: true, nit: base, dv };
}

module.exports = { parseNit, checkDigit };
