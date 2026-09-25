const fs = require("fs");
const path = require("path");

// server.js conecta a Mongo/RabbitMQ apenas se importa (arranca `main()`), asi que no se puede requerir en un test
// unitario: se inspecciona el codigo fuente, igual que hacen registerOperator.cli.test.js (ms-identidad) y
// publishEndpoint.cli.test.js (ms-interoperabilidad) para verificar el arranque de un servicio sin ejecutarlo.
const server = () => fs.readFileSync(path.resolve(__dirname, "..", "src", "server.js"), "utf8");

describe("HU-06.3 (RF-28), Paso 3.3-B: tercer consumidor solicitud.creada en server.js", () => {
  test("registra la cola, routing key y handler de solicitud.creada", () => {
    const src = server();
    expect(src).toContain('queue: "ms-notificaciones.solicitud-creada"');
    expect(src).toContain('routingKey: "solicitud.creada"');
    expect(src).toContain("handler: handlers.solicitudCreada");
  });

  test("son exactamente 3 consumidores (ciudadano.registrado, documento.cargado, solicitud.creada)", () => {
    const src = server();
    const count = (src.match(/new EventConsumer\(/g) || []).length;
    expect(count).toBe(3);
  });

  test("el smsSender se inyecta a NotificationService (mismo patron que emailSender)", () => {
    const src = server();
    expect(src).toContain("createSmsSender(env.sms)");
    expect(src).toMatch(/smsSender:\s*createSmsSender\(env\.sms\)/);
  });

  test("/ready sigue derivandose de TODOS los consumidores de la lista (los 3 quedan incluidos sin cablear un conteo fijo)", () => {
    const src = server();
    expect(src).toContain("consumers.every((c) => Boolean(c.channel))");
  });

  test("no se toco EventConsumer.js: server.js sigue siendo el unico responsable de declarar queue/routingKey por evento", () => {
    const consumerSrc = fs.readFileSync(path.resolve(__dirname, "..", "src", "infrastructure", "EventConsumer.js"), "utf8");
    expect(consumerSrc).toContain('const EXCHANGE = "carpeta-ciudadana.events";');
  });
});
