const crypto = require("crypto");

/**
 * Adaptador de la Registraduria para obtener la CEDULA FIRMADA del ciudadano (HU-01, paso 13 de la arquitectura: al
 * crear la carpeta se guarda su documento de identidad firmado por la Registraduria).
 *
 * La Registraduria no expone un servicio accesible para el proyecto (supuesto 9.4), asi que esta implementacion es
 * SIMULADA con un contrato equivalente:
 *
 *   signedIdCard({ documento, nombre }) -> { buffer (PDF), emitidaEn (Date), huella (sha256 hex) }
 *
 * El PDF dice explicitamente que es una simulacion sin validez oficial. La "firma" es la huella SHA-256 de los datos
 * certificados: permite detectar alteraciones, pero no es una firma digital de la Registraduria. Reemplazarla por un
 * cliente real no toca al resto del servicio.
 */
class SimulatedRegistraduriaDocumentClient {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
  }

  async signedIdCard({ documento, nombre }) {
    const emitidaEn = this.now();
    const fecha = emitidaEn.toISOString().slice(0, 10);
    const huella = crypto.createHash("sha256").update(`${documento}|${nombre}|vigente|${emitidaEn.toISOString()}`).digest("hex");
    const buffer = renderPdf([
      "REGISTRADURIA NACIONAL DEL ESTADO CIVIL (SIMULADA)",
      "",
      "Certificado de cedula de ciudadania",
      "",
      `Numero de cedula: ${documento}`,
      `Nombre: ${nombre}`,
      "Estado: VIGENTE",
      `Fecha de expedicion del certificado: ${fecha}`,
      "",
      `Firma (simulada, SHA-256): ${huella.slice(0, 32)}`,
      `                           ${huella.slice(32)}`,
      "",
      "Documento generado por un adaptador simulado de la Registraduria.",
      "No tiene validez oficial.",
    ]);
    return { buffer, emitidaEn, huella };
  }
}

/** Texto seguro para una cadena literal de PDF: sin caracteres de control y con ( ) \ escapados. */
function pdfText(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\u0000-\u00ff]/g, "?") // Helvetica con WinAnsi: fuera de Latin-1 no hay glifo
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** PDF minimo de una pagina con lineas de texto (Helvetica). Sin dependencias: el contenido es fijo y pequeno. */
function renderPdf(lines) {
  const content = ["BT", "/F1 12 Tf", "72 720 Td", "18 TL", ...lines.map((l) => `(${pdfText(l)}) Tj T*`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

module.exports = { SimulatedRegistraduriaDocumentClient, renderPdf };
