/** Datos invalidos: lleva TODOS los problemas a la vez (mismo patron que PqrsCaseService). */
class ValidationError extends Error {
  constructor(problems) {
    super(problems.join("; "));
    this.name = "ValidationError";
    this.problems = problems;
  }
}
/**
 * No existe ninguna solicitud con ese id PARA ESTA institucion. Se usa tanto si el id no existe como si
 * pertenece a OTRA institucion: no se distingue (404 en ambos casos), mismo principio que `CaseNotFoundError`
 * (HU-07.2) y que `DestinatarioNoEncontradoError` en ms-documentos (HU-10) -- no confirmar/negar entre inquilinos.
 */
class DocumentRequestNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentRequestNotFoundError";
  }
}

// Mismo patron y mismo criterio que InboundDocumentService (ms-documentos, HU-10): solo se comprueba que
// `direccionUnica` tenga FORMA plausible de correo. No se resuelve contra ningun ciudadano ni operador -- quien
// decide si existe de verdad seria una busqueda real, que esta version deliberadamente no hace (HU-05c/HU-06.3).
const DIRECCION_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const MAX_DIRECCION_LENGTH = 200;
const MAX_DESCRIPCION_LENGTH = 2000;
// Mismo formato que `operatorId` en ms-interoperabilidad (OperatorDirectoryService.findOperator). Se valida solo
// la FORMA: no se consulta ningun directorio, porque ms-interoperabilidad no expone ningun endpoint para eso hoy.
const OPERADOR_DESTINO_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

/** Entero positivo estricto ("2" si, "2.5", "-1", "0", "abc" no). Ausente -> valor por defecto. */
function parsePositiveInt(value, fallback, field) {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" && typeof value !== "number") throw new ValidationError([`${field} debe ser un entero positivo`]);
  const text = String(value);
  if (!/^\d{1,9}$/.test(text) || Number(text) < 1) throw new ValidationError([`${field} debe ser un entero positivo`]);
  return Number(text);
}

function toView(doc) {
  return {
    id: String(doc._id),
    institutionId: doc.institutionId,
    direccionUnica: doc.direccionUnica,
    descripcion: doc.descripcion,
    operadorDestinoId: doc.operadorDestinoId || null,
    estado: doc.estado,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * HU-07.3 (RFP-02), implementacion PARCIAL: solo REGISTRA la solicitud de una institucion. Deliberadamente NO
 * hace nada de lo siguiente (dependencia externa pendiente de HU-05c/HU-06.3, ver docs/SEGURIDAD.md, 12.3):
 *   - NO resuelve `direccionUnica` contra un ciudadano real (no hay llamada a ningun otro servicio).
 *   - NO valida `operadorDestinoId` contra el directorio de ms-interoperabilidad (ese servicio no expone hoy
 *     ningun endpoint de negocio para eso); se guarda tal cual, como dato que la institucion YA conocia.
 *   - NO descubre automaticamente el operador actual del ciudadano (esa capacidad no existe en el ecosistema).
 *   - NO envia nada a otro operador, NO pide consentimiento al ciudadano, NO transfiere ningun documento.
 * El unico estado posible es "registrada"; el cliente nunca puede elegir el estado.
 */
class DocumentRequestService {
  constructor({ documentRequestRepository }) {
    this.documentRequestRepository = documentRequestRepository;
  }

  async create({ institutionId, direccionUnica, descripcion, operadorDestinoId }) {
    const problems = [];

    const cleanDireccion = typeof direccionUnica === "string" ? direccionUnica.trim().toLowerCase() : "";
    if (!cleanDireccion) problems.push("direccionUnica es requerida");
    else if (cleanDireccion.length > MAX_DIRECCION_LENGTH || !DIRECCION_RE.test(cleanDireccion)) problems.push("direccionUnica no tiene un formato valido");

    const cleanDescripcion = typeof descripcion === "string" ? descripcion.trim() : "";
    if (!cleanDescripcion) problems.push("descripcion es requerida");
    else if (cleanDescripcion.length > MAX_DESCRIPCION_LENGTH) problems.push(`descripcion no puede superar ${MAX_DESCRIPCION_LENGTH} caracteres`);

    let cleanOperadorDestinoId = null;
    if (operadorDestinoId !== undefined && operadorDestinoId !== null && operadorDestinoId !== "") {
      if (typeof operadorDestinoId !== "string" || !OPERADOR_DESTINO_RE.test(operadorDestinoId)) problems.push("operadorDestinoId no tiene un formato valido");
      else cleanOperadorDestinoId = operadorDestinoId;
    }

    if (problems.length) throw new ValidationError(problems);

    const created = await this.documentRequestRepository.create({
      institutionId,
      direccionUnica: cleanDireccion,
      descripcion: cleanDescripcion,
      operadorDestinoId: cleanOperadorDestinoId,
      estado: "registrada",
    });
    return toView(created);
  }

  /** Solo devuelve solicitudes de `institutionId`; nunca de otra institucion (RNF-07). */
  async list({ institutionId, page, pageSize }) {
    const currentPage = parsePositiveInt(page, DEFAULT_PAGE, "page");
    const size = Math.min(parsePositiveInt(pageSize, DEFAULT_PAGE_SIZE, "pageSize"), MAX_PAGE_SIZE);
    const { items, total } = await this.documentRequestRepository.findByInstitution(institutionId, { skip: (currentPage - 1) * size, limit: size });
    return { solicitudes: items.map(toView), total, currentPage, pageSize: size, totalPages: Math.ceil(total / size) };
  }

  /** 404 (no 403) tanto si el id no existe como si pertenece a otra institucion: ver DocumentRequestNotFoundError. */
  async get({ institutionId, requestId }) {
    if (!OBJECT_ID_RE.test(requestId || "")) throw new ValidationError(["id no tiene un formato valido"]);
    const found = await this.documentRequestRepository.findById(requestId);
    if (!found || found.institutionId !== institutionId) throw new DocumentRequestNotFoundError("solicitud no encontrada");
    return toView(found);
  }
}

module.exports = { DocumentRequestService, ValidationError, DocumentRequestNotFoundError };
