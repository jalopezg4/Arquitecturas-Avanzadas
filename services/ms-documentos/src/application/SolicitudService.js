const { ValidationError } = require("./DocumentService");
const { DestinatarioNoEncontradoError, DIRECCION_RE, MAX_DIRECCION } = require("./InboundDocumentService");

/**
 * No existe ninguna solicitud con ese id PARA ESTA institucion. Se usa tanto si el id no existe como si
 * pertenece a OTRA institucion: no se distingue (404 en ambos casos, nunca 403) -- mismo principio que
 * `DestinatarioNoEncontradoError` (HU-10) y que `CaseNotFoundError`/`DocumentRequestNotFoundError` en
 * ms-analitica (HU-07.2/07.3): no confirmar ni negar existencia entre inquilinos.
 */
class SolicitudNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "SolicitudNotFoundError";
  }
}
/** La solicitud ya tiene una decision (autorizada o rechazada). No hay revocacion de consentimiento en esta HU. */
class SolicitudYaDecididaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SolicitudYaDecididaError";
  }
}

const MAX_DESCRIPCION_LENGTH = 2000;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const DECISIONES = { autorizar: "autorizada", rechazar: "rechazada" };

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

/** Entero positivo estricto ("2" si, "2.5", "-1", "0", "abc" no). Ausente -> valor por defecto. */
function parsePositiveInt(value, fallback, field) {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" && typeof value !== "number") throw new ValidationError(`${field} debe ser un entero positivo`);
  const text = String(value);
  if (!/^\d{1,9}$/.test(text) || Number(text) < 1) throw new ValidationError(`${field} debe ser un entero positivo`);
  return Number(text);
}

/** Lo que ve la institucion: nunca ciudadanoId, nunca institutionId (ya lo sabe). */
function toInstitutionView(doc) {
  return {
    id: String(doc._id),
    direccionUnica: doc.direccionUnica,
    descripcion: doc.descripcion,
    estado: doc.estado,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Lo que ve el CIUDADANO: nunca ciudadanoId (ya lo sabe, es el; no hay razon para devolverselo), pero SI
 * `institutionId` -- a diferencia de la vista institucional, aqui identifica quien hizo la solicitud, informacion
 * que el ciudadano necesita para decidir si autoriza o rechaza.
 */
function toCitizenView(doc) {
  return {
    id: String(doc._id),
    institutionId: doc.institutionId,
    direccionUnica: doc.direccionUnica,
    descripcion: doc.descripcion,
    estado: doc.estado,
    decisionAt: doc.decisionAt,
    decisionBy: doc.decisionBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * HU-06.3 (RF-27/28/29). PASO 1: nucleo institucional (crear/consultar solicitudes). PASO 2 (este agregado):
 * consulta y decision del CIUDADANO. Todavia NO implementa notificaciones (correo/SMS) ni ningun mecanismo de
 * entrega documental: `autorizada` es solo un estado, no dispara nada (eso es HU-06.2, fuera de este paso).
 *
 * `direccionUnica` se valida por FORMA con exactamente la misma expresion (`DIRECCION_RE`/`MAX_DIRECCION`) que
 * `InboundDocumentService` (HU-10): reutilizada por import, no duplicada. A diferencia de HU-10 -- donde una
 * direccion malformada y una inexistente responden IGUAL (404, para no revelar nada al entregar un documento) --
 * aqui se distinguen a proposito: formato invalido es un error del CLIENTE (400, "arreglalo y reintenta"), y solo
 * una direccion bien formada que no resuelve a ningun ciudadano de este operador es `DestinatarioNoEncontradoError`
 * (404, mismo mensaje que HU-10). Es una decision explicita de este paso, no un descuido; queda anotada para
 * revisión antes del PASO 2 por si se prefiere endurecerla al criterio de HU-10.
 */
class SolicitudService {
  constructor({ solicitudRepository, folderRepository }) {
    this.solicitudRepository = solicitudRepository;
    this.folderRepository = folderRepository;
  }

  async create({ institutionId, direccionUnica, descripcion }) {
    const cleanDireccion = typeof direccionUnica === "string" ? direccionUnica.trim() : "";
    if (!cleanDireccion) throw new ValidationError("direccionUnica es requerida");
    if (cleanDireccion.length > MAX_DIRECCION || !DIRECCION_RE.test(cleanDireccion)) {
      throw new ValidationError("direccionUnica no tiene un formato valido");
    }

    const cleanDescripcion = typeof descripcion === "string" ? descripcion.trim() : "";
    if (!cleanDescripcion) throw new ValidationError("descripcion es requerida");
    if (cleanDescripcion.length > MAX_DESCRIPCION_LENGTH) throw new ValidationError(`descripcion no puede superar ${MAX_DESCRIPCION_LENGTH} caracteres`);

    // Mismo criterio de normalizacion que FolderRepository (trim + minusculas): son direcciones de correo, no
    // distinguen mayusculas. findByDireccionUnica normaliza igual internamente; se guarda ya normalizada aqui
    // para que lo almacenado sea consistente con lo que Folder usa para resolver.
    const direccionNormalizada = cleanDireccion.toLowerCase();

    const carpeta = await this.folderRepository.findByDireccionUnica(direccionNormalizada);
    if (!carpeta) throw new DestinatarioNoEncontradoError();

    const created = await this.solicitudRepository.create({
      institutionId,
      ciudadanoId: carpeta.ciudadanoId,
      direccionUnica: direccionNormalizada,
      descripcion: cleanDescripcion,
      estado: "pendiente_autorizacion",
    });
    return toInstitutionView(created);
  }

  /** Solo devuelve solicitudes de `institutionId`; nunca de otra institucion. */
  async list({ institutionId, page, pageSize }) {
    const currentPage = parsePositiveInt(page, DEFAULT_PAGE, "page");
    const size = Math.min(parsePositiveInt(pageSize, DEFAULT_PAGE_SIZE, "pageSize"), MAX_PAGE_SIZE);
    const { items, total } = await this.solicitudRepository.findByInstitution(institutionId, { skip: (currentPage - 1) * size, limit: size });
    return { solicitudes: items.map(toInstitutionView), total, currentPage, pageSize: size, totalPages: Math.ceil(total / size) };
  }

  /** 404 (no 403) tanto si el id no existe como si pertenece a otra institucion. */
  async get({ institutionId, solicitudId }) {
    if (!OBJECT_ID_RE.test(solicitudId || "")) throw new ValidationError("id no tiene un formato valido");
    const found = await this.solicitudRepository.findById(solicitudId);
    if (!found || found.institutionId !== institutionId) throw new SolicitudNotFoundError("solicitud no encontrada");
    return toInstitutionView(found);
  }

  /** Solo devuelve solicitudes de `ciudadanoId`; nunca de otro ciudadano (PASO 2). */
  async listForCitizen({ ciudadanoId, page, pageSize }) {
    const currentPage = parsePositiveInt(page, DEFAULT_PAGE, "page");
    const size = Math.min(parsePositiveInt(pageSize, DEFAULT_PAGE_SIZE, "pageSize"), MAX_PAGE_SIZE);
    const { items, total } = await this.solicitudRepository.findByCitizen(ciudadanoId, { skip: (currentPage - 1) * size, limit: size });
    return { solicitudes: items.map(toCitizenView), total, currentPage, pageSize: size, totalPages: Math.ceil(total / size) };
  }

  /**
   * Autoriza o rechaza una solicitud propia (PASO 2). 404 (no 403) tanto si no existe como si es de otro
   * ciudadano -- no se distingue, mismo criterio que `get()`. 409 si ya tenia una decision: no hay revocacion.
   *
   * La transicion es ATOMICA a nivel de Mongo (`findOneAndUpdate` con `estado: "pendiente_autorizacion"` en el
   * FILTRO, no solo en la actualizacion): si dos peticiones llegan a la vez, el indice _id decide cual gana la
   * escritura y la otra encuentra el filtro ya no calza (estado cambio), asi que nunca se pisan una decision con
   * otra. El `findById` previo es solo para dar el codigo HTTP correcto (404 vs 409); la garantia real de "una
   * sola decision" la da el filtro atomico, no esta lectura.
   */
  async decide({ ciudadanoId, solicitudId, decision }) {
    if (!Object.prototype.hasOwnProperty.call(DECISIONES, decision)) throw new ValidationError("decision debe ser 'autorizar' o 'rechazar'");
    if (!OBJECT_ID_RE.test(solicitudId || "")) throw new ValidationError("id no tiene un formato valido");

    const existing = await this.solicitudRepository.findById(solicitudId);
    if (!existing || existing.ciudadanoId !== ciudadanoId) throw new SolicitudNotFoundError("solicitud no encontrada");
    if (existing.estado !== "pendiente_autorizacion") throw new SolicitudYaDecididaError("la solicitud ya tiene una decision registrada");

    const updated = await this.solicitudRepository.decide(solicitudId, ciudadanoId, {
      estado: DECISIONES[decision],
      decisionAt: new Date(),
      decisionBy: ciudadanoId,
    });
    // null solo puede significar que el filtro atomico ya no calzo: otra peticion decidio primero entre el
    // findById de arriba y este update (carrera genuina, no un error de programacion).
    if (!updated) throw new SolicitudYaDecididaError("la solicitud ya tiene una decision registrada");
    return toCitizenView(updated);
  }
}

module.exports = { SolicitudService, SolicitudNotFoundError, SolicitudYaDecididaError };
