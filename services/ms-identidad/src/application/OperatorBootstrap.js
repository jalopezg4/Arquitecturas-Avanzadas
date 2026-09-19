const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class OperatorInputError extends Error {
  constructor(problems) {
    super(`Datos del operador invalidos:\n - ${problems.join("\n - ")}`);
    this.name = "OperatorInputError";
    this.problems = problems;
  }
}

/** El operador ya existe (configurado localmente o en el directorio): NO se envia ningun POST. */
class OperatorAlreadyRegisteredError extends Error {
  constructor(message, { operatorId } = {}) {
    super(message);
    this.name = "OperatorAlreadyRegisteredError";
    this.operatorId = operatorId;
  }
}

class OperatorRegistrationError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "OperatorRegistrationError";
    this.cause = cause;
  }
}

const norm = (s) => String(s || "").trim().toLowerCase();

/**
 * HU-11 (RF-34): da de alta el operador en GovCarpeta y entrega el operatorId que exigen
 * registerCitizen / authenticateDocument / registerTransferEndPoint.
 *
 * No es parte del arranque del servicio: se ejecuta UNA vez por ambiente (script de infraestructura).
 * El directorio de GovCarpeta es compartido y no tiene endpoint de borrado, por eso antes de crear
 * nada se comprueba que no exista ya, y un POST nunca se reintenta a ciegas.
 */
class OperatorBootstrap {
  constructor({ govCarpetaClient }) {
    this.client = govCarpetaClient;
  }

  static validate({ name, address, contactMail, participants }) {
    const problems = [];
    if (!name || !String(name).trim()) problems.push("OPERATOR_NAME es requerido");
    if (!address || !String(address).trim()) problems.push("OPERATOR_ADDRESS es requerido");
    if (!contactMail || !EMAIL_RE.test(contactMail)) problems.push("OPERATOR_CONTACT_MAIL debe ser un correo valido");
    if (!Array.isArray(participants) || participants.length === 0 || participants.some((p) => !String(p).trim())) {
      problems.push("OPERATOR_PARTICIPANTS debe listar al menos un integrante (separados por coma)");
    }
    return problems;
  }

  async _findByName(name) {
    const operators = await this.client.listOperators();
    return operators.find((o) => norm(o.name) === norm(name)) || null;
  }

  /**
   * @param {object} data       name, address, contactMail, participants
   * @param {object} options    currentOperatorId (ya configurado), dryRun, payloadStyle
   * @returns {{status: "dry-run"|"registered"|"recovered", operatorId?: string, payload?: object}}
   */
  async register(data, { currentOperatorId, dryRun = false, payloadStyle } = {}) {
    const problems = OperatorBootstrap.validate(data);
    if (problems.length) throw new OperatorInputError(problems);

    if (currentOperatorId) {
      throw new OperatorAlreadyRegisteredError(
        `Este ambiente ya tiene un operador configurado (OPERATOR_ID=${currentOperatorId}). Se registra una sola vez por ambiente; ` +
          "no se envio nada a GovCarpeta.",
        { operatorId: currentOperatorId }
      );
    }

    let existing;
    try {
      existing = await this._findByName(data.name);
    } catch (err) {
      // Sin poder comprobar duplicados no se crea nada: el directorio no permite deshacerlo.
      throw new OperatorRegistrationError(
        "No se pudo consultar el directorio de operadores para descartar un duplicado; no se registro nada. Reintenta mas tarde.",
        { cause: err }
      );
    }
    if (existing) {
      throw new OperatorAlreadyRegisteredError(
        `Ya existe un operador llamado "${existing.name}" en GovCarpeta (id ${existing.id}). No se creo un duplicado. ` +
          `Si es el de ustedes, configura OPERATOR_ID=${existing.id}; si es de otro equipo, usa un OPERATOR_NAME distinto.`,
        { operatorId: existing.id }
      );
    }

    const payload = { name: data.name.trim(), address: data.address.trim(), contactMail: data.contactMail.trim(), participants: data.participants.map((p) => String(p).trim()) };
    if (dryRun) return { status: "dry-run", payload };

    try {
      const { operatorId } = await this.client.registerOperator(payload, { payloadStyle });
      return { status: "registered", operatorId, payload };
    } catch (err) {
      const httpStatus = err.response && err.response.status;
      if (httpStatus === 501) {
        throw new OperatorRegistrationError(
          "GovCarpeta rechazo los datos (501 Wrong Parameters). El Swagger es inconsistente con los nombres de campo: " +
            "reintenta con --payload-style=properties o --payload-style=required. No se creo ningun operador.",
          { cause: err }
        );
      }
      // Resultado desconocido (sin respuesta, 5xx, 201 sin id): pudo haberse creado. Se revisa el directorio.
      try {
        const created = await this._findByName(data.name);
        if (created) return { status: "recovered", operatorId: created.id, payload };
      } catch {
        // si tampoco se puede consultar, se informa abajo
      }
      throw new OperatorRegistrationError(
        "No se pudo confirmar el registro (GovCarpeta no respondio como se esperaba). NO lo reintentes a ciegas: el directorio no permite borrar " +
          `y podrias duplicar el operador. Revisa https://govcarpeta-apis-4905ff3c005b.herokuapp.com/apis/getOperators buscando "${data.name}" ` +
          "y, si aparece, configura su id como OPERATOR_ID.",
        { cause: err }
      );
    }
  }
}

module.exports = { OperatorBootstrap, OperatorInputError, OperatorAlreadyRegisteredError, OperatorRegistrationError };
