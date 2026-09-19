const multer = require("multer");
const { runWithTrace } = require("../tracing/TraceContext");
const { UnsupportedMediaTypeError, PayloadTooLargeError, ValidationError } = require("../application/DocumentService");

/**
 * Recibe UN archivo (campo "archivo") en memoria, con limites duros: tamano, cantidad de archivos y de campos.
 * El PDF se rechaza pronto por tipo declarado; la validacion definitiva (firma real del PDF, metadatos) es del servicio.
 */
function uploadMiddleware({ maxUploadBytes }) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 10, fieldSize: 4096, parts: 12 },
    fileFilter: (_req, file, cb) => (file.mimetype === "application/pdf" ? cb(null, true) : cb(new UnsupportedMediaTypeError("solo se aceptan archivos PDF"))),
  }).single("archivo");

  return function receive(req, res, next) {
    upload(req, res, (err) => {
      // multer termina dentro de un evento de stream, fuera del contexto del request: sin esto, todo lo que corre
      // despues (servicio, logs, bitacora) perderia el trace-id (HT-06).
      if (!err) return runWithTrace(req.traceId, () => next());
      return runWithTrace(req.traceId, () => {
        if (err instanceof UnsupportedMediaTypeError) return next(err);
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") return next(new PayloadTooLargeError(`el archivo supera el maximo de ${maxUploadBytes} bytes`));
          return next(new ValidationError("formulario invalido: se espera un solo archivo en el campo archivo y campos de texto"));
        }
        return next(err);
      });
    });
  };
}

module.exports = uploadMiddleware;
