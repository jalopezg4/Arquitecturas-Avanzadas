/**
 * server.js no se ejecuta en las pruebas (conecta a Mongo/RabbitMQ reales): se verifica su cableado como texto, igual
 * que en ms-notificaciones. Protege contra renombrar la cola o la routing key y romper el contrato con ms-documentos.
 */
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
const publisher = fs.readFileSync(path.join(__dirname, "..", "src", "infrastructure", "EventPublisher.js"), "utf8");

test("consume documento.autenticacion_solicitada en la cola que predeclara ms-documentos", () => {
  expect(source).toContain('queue: "ms-autenticacion.autenticacion-solicitada"');
  expect(source).toContain('routingKey: "documento.autenticacion_solicitada"');
  expect(source).toContain("handler: handlers.autenticacionSolicitada");
});

test("crea el indice unico de intentos ANTES de consumir", () => {
  expect(source.indexOf("AuthenticationAttempt.init()")).toBeGreaterThan(-1);
  expect(source.indexOf("AuthenticationAttempt.init()")).toBeLessThan(source.indexOf("consumer.start()"));
});

test("predeclara las colas de resultado para ms-documentos y ms-notificaciones", () => {
  for (const queue of [
    "ms-documentos.documento-autenticado",
    "ms-documentos.documento-autenticacion-fallida",
    "ms-notificaciones.documento-autenticado",
    "ms-notificaciones.documento-autenticacion-fallida",
  ]) {
    expect(publisher).toContain(`queue: "${queue}"`);
  }
});
