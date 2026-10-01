/**
 * HU-05c (revision del PR #90): toda cola que CONSUME un evento de la saga de transferencia (en cualquier servicio) debe
 * estar pre-declarada por este publicador. Si no, con el consumidor caido RabbitMQ descarta el mensaje (nadie esta
 * ligado al topic) y la orden se pierde -- p. ej. la reversion del registro en ms-identidad.
 */
const fs = require("fs");
const path = require("path");
const EventPublisher = require("../src/infrastructure/EventPublisher");

async function declaredBindings() {
  const declared = [];
  const channel = {
    assertExchange: jest.fn(async () => {}),
    assertQueue: jest.fn(async () => {}),
    bindQueue: jest.fn(async (queue, _exchange, routingKey) => declared.push(`${queue} <- ${routingKey}`)),
    on: jest.fn(),
  };
  const conn = { on: jest.fn(), createConfirmChannel: jest.fn(async () => channel) };
  await new EventPublisher("amqp://test", { connect: async () => conn }).connect();
  return declared;
}

/** Colas consumidas en los server.js de los otros servicios para eventos de la saga (transferencia.* y ciudadano.transferido). */
function sagaConsumers() {
  const services = path.resolve(__dirname, "..", "..");
  const found = [];
  for (const svc of fs.readdirSync(services).filter((d) => d.startsWith("ms-") && d !== "ms-interoperabilidad")) {
    const file = path.join(services, svc, "src", "server.js");
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/queue:\s*"([^"]+)",\s*routingKey:\s*"((?:transferencia\.[a-z_]+)|ciudadano\.transferido)"/g)) found.push(`${m[1]} <- ${m[2]}`);
  }
  return found;
}

test("cada consumidor de un evento de la saga tiene su cola pre-declarada", async () => {
  const consumers = sagaConsumers();
  expect(consumers.length).toBeGreaterThanOrEqual(9);
  const declared = await declaredBindings();
  for (const c of consumers) expect(declared).toContain(c);
});
