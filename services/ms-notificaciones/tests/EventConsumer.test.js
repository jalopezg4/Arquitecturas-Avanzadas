const { EventConsumer, PermanentError, EXCHANGE } = require("../src/infrastructure/EventConsumer");
const { getTraceId } = require("../src/tracing/TraceContext");

/** Broker en memoria: conexion y canal con la misma interfaz que amqplib, y un metodo para "entregar" mensajes. */
function makeFakeBroker() {
  const state = { connections: [], channels: [], handlers: [] };
  const makeChannel = () => {
    const ch = {
      assertExchange: jest.fn(async () => {}),
      assertQueue: jest.fn(async () => {}),
      bindQueue: jest.fn(async () => {}),
      prefetch: jest.fn(async () => {}),
      consume: jest.fn(async (_queue, cb) => {
        state.handlers.push(cb);
      }),
      ack: jest.fn(),
      nack: jest.fn(),
      sendToQueue: jest.fn(),
      close: jest.fn(async () => {}),
    };
    state.channels.push(ch);
    return ch;
  };
  const connect = jest.fn(async () => {
    const listeners = {};
    const conn = {
      on: (evt, fn) => {
        listeners[evt] = fn;
      },
      emit: (evt, arg) => listeners[evt] && listeners[evt](arg),
      createChannel: async () => makeChannel(),
      close: jest.fn(async () => {}),
    };
    state.connections.push(conn);
    return conn;
  });
  const deliver = (payload, headers = {}) => {
    const content = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    const msg = { content, properties: { headers } };
    state.handlers[state.handlers.length - 1](msg);
    return msg;
  };
  return { state, connect, deliver };
}

const flush = () => new Promise((r) => setImmediate(r));

async function started(options = {}) {
  const broker = makeFakeBroker();
  const handler = options.handler || jest.fn(async () => {});
  const consumer = new EventConsumer({ uri: "amqp://x", queue: "ms-notificaciones.prueba", routingKey: "documento.algo", handler, connect: broker.connect, retryDelayMs: 20, ...options });
  await consumer.start();
  return { broker, consumer, handler, channel: () => broker.state.channels[broker.state.channels.length - 1] };
}

describe("EventConsumer -- topologia", () => {
  test("declara exchange topic durable, cola durable ligada a la routing key, prefetch acotado y consume", async () => {
    const { channel } = await started({ prefetch: 3 });
    const ch = channel();

    expect(ch.assertExchange).toHaveBeenCalledWith(EXCHANGE, "topic", { durable: true });
    expect(ch.bindQueue).toHaveBeenCalledWith("ms-notificaciones.prueba", EXCHANGE, "documento.algo");
    expect(ch.prefetch).toHaveBeenCalledWith(3);
    expect(ch.consume).toHaveBeenCalledWith("ms-notificaciones.prueba", expect.any(Function));
  });

  test("la cola principal se declara SOLO como durable (igual que el publicador: si difiere, el broker rechaza la redeclaracion)", async () => {
    const { channel } = await started();
    const declared = channel().assertQueue.mock.calls.filter((c) => c[0] === "ms-notificaciones.prueba");
    expect(declared).toEqual([["ms-notificaciones.prueba", { durable: true }]]);
  });

  test("declara tambien la cola de FALLIDOS (<cola>.fallidos)", async () => {
    const { channel } = await started();
    expect(channel().assertQueue).toHaveBeenCalledWith("ms-notificaciones.prueba.fallidos", { durable: true });
  });
});

describe("EventConsumer -- ack / nack / cola de fallidos", () => {
  test("ACK solo despues de que el manejador termino bien", async () => {
    let finish;
    const handler = jest.fn(() => new Promise((r) => (finish = r)));
    const { broker, channel } = await started({ handler });

    const msg = broker.deliver({ documentoId: "x" });
    await flush();
    expect(channel().ack).not.toHaveBeenCalled();

    finish();
    await flush();
    expect(channel().ack).toHaveBeenCalledWith(msg);
    expect(handler).toHaveBeenCalledWith({ documentoId: "x" });
  });

  test("PermanentError -> se REPUBLICA en la cola de fallidos con el motivo y solo entonces se hace ACK (no se pierde)", async () => {
    const handler = jest.fn(async () => {
      throw new PermanentError("contacto inexistente");
    });
    const { broker, channel } = await started({ handler });

    const msg = broker.deliver({ a: 1 }, { "x-trace-id": "traza-origen-001" });
    await flush();

    expect(channel().sendToQueue).toHaveBeenCalledTimes(1);
    const [queue, content, options] = channel().sendToQueue.mock.calls[0];
    expect(queue).toBe("ms-notificaciones.prueba.fallidos");
    expect(content).toBe(msg.content); // el mismo mensaje, intacto, para poder reprocesarlo
    expect(options).toMatchObject({ persistent: true });
    expect(options.headers).toMatchObject({ "x-motivo-fallo": "contacto inexistente", "x-cola-origen": "ms-notificaciones.prueba", "x-trace-id": "traza-origen-001" });
    expect(channel().ack).toHaveBeenCalledWith(msg);
    expect(channel().nack).not.toHaveBeenCalled();
  });

  test("JSON invalido -> tambien a la cola de fallidos, y el manejador ni se llama", async () => {
    const { broker, channel, handler } = await started();

    const msg = broker.deliver(Buffer.from("{esto no es json"));
    await flush();

    expect(channel().sendToQueue.mock.calls[0][0]).toBe("ms-notificaciones.prueba.fallidos");
    expect(channel().sendToQueue.mock.calls[0][2].headers["x-motivo-fallo"]).toBe("JSON invalido");
    expect(channel().ack).toHaveBeenCalledWith(msg);
    expect(handler).not.toHaveBeenCalled();
  });

  test("si NO se puede republicar en fallidos, el mensaje vuelve a la cola (nunca se descarta)", async () => {
    const handler = jest.fn(async () => {
      throw new PermanentError("mal formado");
    });
    const { broker, channel } = await started({ handler });
    channel().sendToQueue.mockImplementation(() => {
      throw new Error("canal cerrado");
    });

    const msg = broker.deliver({ a: 1 });
    await flush();

    expect(channel().ack).not.toHaveBeenCalled();
    expect(channel().nack).toHaveBeenCalledWith(msg, false, true);
  });

  test("fallo TRANSITORIO (p. ej. correo o Mongo caidos) -> se devuelve a la cola tras una pausa, sin girar en vacio", async () => {
    const handler = jest.fn(async () => {
      throw new Error("smtp caido");
    });
    const { broker, channel } = await started({ handler });

    const msg = broker.deliver({ a: 1 });
    await flush();
    expect(channel().nack).not.toHaveBeenCalled(); // no se reencola de inmediato

    await new Promise((r) => setTimeout(r, 60));
    expect(channel().nack).toHaveBeenCalledWith(msg, false, true);
    expect(channel().ack).not.toHaveBeenCalled();
    expect(channel().sendToQueue).not.toHaveBeenCalled(); // un fallo transitorio NO va a fallidos
  });

  test("RETROCESO EXPONENCIAL: cada fallo espera el doble (1, 2, 4...) y se acota en maxRetryDelayMs", async () => {
    jest.useFakeTimers();
    try {
      const handler = jest.fn(async () => {
        throw new Error("smtp caido");
      });
      const { broker, channel } = await started({ handler, retryDelayMs: 1000, maxRetryDelayMs: 5000, maxAttempts: 10 });
      const delays = [];
      for (let i = 0; i < 5; i++) {
        const msg = broker.deliver({ igual: "mensaje" }); // la MISMA carga en cada reentrega
        await jest.advanceTimersByTimeAsync(0);
        const before = channel().nack.mock.calls.length;
        let waited = 0;
        while (channel().nack.mock.calls.length === before && waited < 20000) {
          await jest.advanceTimersByTimeAsync(500);
          waited += 500;
        }
        delays.push(waited);
        expect(channel().nack).toHaveBeenLastCalledWith(msg, false, true);
      }
      expect(delays).toEqual([1000, 2000, 4000, 5000, 5000]); // 1 s, 2 s, 4 s y luego el tope
    } finally {
      jest.useRealTimers();
    }
  });

  test("TOPE de intentos: agotado maxAttempts el mensaje va a la cola de fallidos (no gira para siempre) y NO se pierde", async () => {
    const handler = jest.fn(async () => {
      throw new Error("smtp caido");
    });
    const { broker, channel } = await started({ handler, maxAttempts: 3, retryDelayMs: 1, maxRetryDelayMs: 1 });

    let last;
    for (let i = 0; i < 3; i++) {
      last = broker.deliver({ a: 1 });
      await new Promise((r) => setTimeout(r, 15));
    }

    expect(channel().nack).toHaveBeenCalledTimes(2); // intentos 1 y 2 se reencolan
    expect(channel().sendToQueue).toHaveBeenCalledTimes(1); // el 3.o va a fallidos
    expect(channel().sendToQueue.mock.calls[0][2].headers["x-motivo-fallo"]).toBe("reintentos agotados (3): smtp caido");
    expect(channel().ack).toHaveBeenCalledWith(last);
  });

  test("el contador es POR MENSAJE: un mensaje que falla no consume los intentos de otro", async () => {
    const handler = jest.fn(async (payload) => {
      if (payload.falla) throw new Error("no");
    });
    const { broker, channel } = await started({ handler, maxAttempts: 2, retryDelayMs: 1, maxRetryDelayMs: 1 });

    broker.deliver({ falla: true });
    await new Promise((r) => setTimeout(r, 15));
    const ok = broker.deliver({ falla: false });
    await flush();

    expect(channel().ack).toHaveBeenCalledWith(ok);
    expect(channel().sendToQueue).not.toHaveBeenCalled(); // el que fallo lleva 1 intento de 2
  });

  test("un exito borra la cuenta: si el mismo mensaje vuelve a fallar despues, empieza de cero", async () => {
    let fallar = true;
    const handler = jest.fn(async () => {
      if (fallar) throw new Error("no");
    });
    const { broker, channel, consumer } = await started({ handler, maxAttempts: 3, retryDelayMs: 1, maxRetryDelayMs: 1 });

    broker.deliver({ a: 1 });
    await new Promise((r) => setTimeout(r, 15));
    expect(consumer._attempts.size).toBe(1);
    fallar = false;
    broker.deliver({ a: 1 });
    await flush();

    expect(consumer._attempts.size).toBe(0);
    expect(channel().ack).toHaveBeenCalledTimes(1);
  });

  test("un mensaje null (consumidor cancelado por el broker) se ignora", async () => {
    const { broker, handler } = await started();
    expect(() => broker.state.handlers[0](null)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("EventConsumer -- trazabilidad (HT-06)", () => {
  test("el manejador corre con el trace-id del encabezado del mensaje", async () => {
    let seen;
    const { broker } = await started({
      handler: async () => {
        seen = getTraceId();
      },
    });

    broker.deliver({ a: 1 }, { "x-trace-id": "traza-de-origen-01" });
    await flush();

    expect(seen).toBe("traza-de-origen-01");
  });

  test("sin encabezado, o con uno malicioso, se genera uno propio", async () => {
    const seen = [];
    const { broker } = await started({
      handler: async () => {
        seen.push(getTraceId());
      },
    });

    broker.deliver({ a: 1 });
    broker.deliver({ a: 2 }, { "x-trace-id": 'a b"c{' });
    await flush();

    expect(seen).toHaveLength(2);
    for (const id of seen) expect(id).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });
});

describe("EventConsumer -- reconexion", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("si la conexion se cae, vuelve a conectar y a consumir con espera creciente", async () => {
    const { broker, consumer } = await started();
    expect(broker.connect).toHaveBeenCalledTimes(1);

    broker.state.connections[0].emit("close");
    await jest.advanceTimersByTimeAsync(1000);
    expect(broker.connect).toHaveBeenCalledTimes(2);
    expect(broker.state.handlers).toHaveLength(2);

    broker.connect.mockRejectedValueOnce(new Error("aun caido"));
    broker.state.connections[1].emit("close");
    await jest.advanceTimersByTimeAsync(2000);
    expect(broker.connect).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(4000);
    expect(broker.connect).toHaveBeenCalledTimes(4);
    await consumer.stop();
  });

  test("stop() cancela las reconexiones pendientes y no vuelve a conectar", async () => {
    const { broker, consumer } = await started();
    broker.state.connections[0].emit("close");

    await consumer.stop();
    await jest.advanceTimersByTimeAsync(60000);

    expect(broker.connect).toHaveBeenCalledTimes(1);
  });
});
