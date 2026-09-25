const { ConsoleSmsSender, createSmsSender } = require("../src/infrastructure/SmsSenders");
const logger = require("../src/tracing/logger");

describe("ConsoleSmsSender (HU-06.3, RF-28: SMS simulado)", () => {
  test("recibe {to, text} y no lanza", async () => {
    await expect(new ConsoleSmsSender().send({ to: "+57 3001234567", text: "Tienes una solicitud pendiente" })).resolves.toBeDefined();
  });

  test("resuelve exitosamente y no envia nada real", async () => {
    const res = await new ConsoleSmsSender().send({ to: "+57 3001234567", text: "Tienes una solicitud pendiente" });
    expect(res.messageId).toBe("console");
  });

  test("deja constancia en el log SIN el numero ni el texto", async () => {
    const lines = [];
    logger.setSink((l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)));

    await new ConsoleSmsSender().send({ to: "+57 3001234567", text: "Tienes una solicitud pendiente" });
    logger.resetSink();

    const dump = lines.join("\n");
    expect(dump).toContain("sms.simulado");
    for (const pii of ["+57 3001234567", "Tienes una solicitud pendiente"]) expect(dump).not.toContain(pii);
  });
});

describe("createSmsSender()", () => {
  test("por ahora siempre entrega ConsoleSmsSender (sin proveedor real)", () => {
    expect(createSmsSender({ transport: "console" })).toBeInstanceOf(ConsoleSmsSender);
  });
});
