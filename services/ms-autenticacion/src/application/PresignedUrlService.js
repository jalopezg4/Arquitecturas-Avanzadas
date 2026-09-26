/**
 * HU-04 / ADR-06: URL prefirmada de LECTURA sobre el documento, con vigencia EXACTA de `ttlSeconds` (15 minutos por
 * defecto, tope validado al arrancar). Es lo unico que ve GovCarpeta: nunca recibe el archivo.
 *
 * Solo firma claves con la forma que genera ms-documentos (`ciudadanos/<ciudadanoId>/<uuid>.pdf`) y del MISMO
 * ciudadano del evento: aunque alguien lograra publicar en el bus, no podria obtener aqui una URL para otro objeto
 * del bucket.
 */
const KEY_RE = /^ciudadanos\/([A-Za-z0-9_-]{1,64})\/[A-Za-z0-9-]{1,64}\.pdf$/;

class InvalidStorageKeyError extends Error {
  constructor() {
    super("clave de objeto invalida para este ciudadano");
    this.name = "InvalidStorageKeyError";
  }
}

class PresignedUrlService {
  constructor({ storage, ttlSeconds = 900, now = () => new Date() }) {
    this.storage = storage;
    this.ttlSeconds = ttlSeconds;
    this.now = now;
  }

  static isValidKey(storageKey, ciudadanoId) {
    const match = typeof storageKey === "string" ? KEY_RE.exec(storageKey) : null;
    return Boolean(match) && match[1] === ciudadanoId;
  }

  /** @returns {Promise<{url: string, expiraEn: Date}>} */
  async generate(storageKey, ciudadanoId) {
    if (!PresignedUrlService.isValidKey(storageKey, ciudadanoId)) throw new InvalidStorageKeyError();
    const url = await this.storage.presignedGetUrl(storageKey, this.ttlSeconds);
    return { url, expiraEn: new Date(this.now().getTime() + this.ttlSeconds * 1000) };
  }
}

module.exports = { PresignedUrlService, InvalidStorageKeyError };
