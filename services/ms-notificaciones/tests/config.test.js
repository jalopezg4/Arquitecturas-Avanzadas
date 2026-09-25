// env.js llama a dotenv, que releeria el .env del desarrollador y repondria justo las variables que cada prueba borra a
// proposito: la prueba dependeria de la maquina donde corre. Se desactiva aqui.
jest.mock("dotenv", () => ({ config: () => ({}) }));

const request = require("supertest");
const { validateConfig, assertValidConfig, ConfigError } = require("../src/config/ConfigValidator");
const buildApp = require("../src/app");

// Las URIs con usuario:contrasena se ARMAN aqui en vez de escribirse completas: son valores falsos de prueba, pero un
// escaner de secretos no distingue un fixture de una credencial real y abre alertas.
const cred = (scheme, user, pass, rest) => [scheme, "://", user, ":", pass, "@", rest].join("");

const prod = (overrides = {}) => ({
  isLocal: false,
  rabbitUri: cred("amqps", "svc", "Zq8mV2nX9pLr", "broker.interno:5671"),
  mongoUri: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "cluster0.mongodb.net/ms-notificaciones"),
  mail: { transport: "smtp", from: "no-responder@carpetacolombia.co", smtp: { host: "smtp.proveedor.co", port: 587, user: "apikey-prod", pass: "w8Zk3Tq0mVx2Lr7Pn5Yc1H", security: "starttls", timeoutMs: 8000 } },
  sms: { transport: "console" },
  staleClaimMs: 60000,
  ...overrides,
});
const withSmtp = (extra) => prod({ mail: { ...prod().mail, smtp: { ...prod().mail.smtp, ...extra } } });

describe("ConfigValidator de ms-notificaciones", () => {
  test("una configuracion de produccion bien formada no tiene problemas", () => {
    expect(validateConfig(prod())).toEqual([]);
  });

  test("fuera de local el transporte console se RECHAZA: con el nadie recibiria los avisos (fallo silencioso)", () => {
    const problems = validateConfig(prod({ mail: { ...prod().mail, transport: "console" } })).join("\n");
    expect(problems).toContain("EMAIL_TRANSPORT debe ser smtp");
  });

  test("en local se acepta console y no se exige SMTP", () => {
    expect(validateConfig({ isLocal: true, rabbitUri: "amqp://localhost", mongoUri: "mongodb://localhost/x", mail: { transport: "console", from: "a@b.co", smtp: {} }, sms: { transport: "console" }, staleClaimMs: 1000 })).toEqual([]);
  });

  test("EMAIL_TRANSPORT desconocido y MAIL_FROM invalido, tambien en local", () => {
    const problems = validateConfig({ isLocal: true, mail: { transport: "paloma", from: "no-es-correo", smtp: {} }, sms: { transport: "console" }, staleClaimMs: 1000 }).join("\n");
    expect(problems).toContain("EMAIL_TRANSPORT debe ser uno de");
    expect(problems).toContain("MAIL_FROM debe ser un correo valido");
  });

  test("con smtp fuera de local exige host, usuario y contrasena que no sea debil", () => {
    expect(validateConfig(withSmtp({ host: "", user: "", pass: "" })).join("\n")).toMatch(/SMTP_HOST es obligatorio[\s\S]*SMTP_USER es obligatorio[\s\S]*SMTP_PASS es obligatorio/);
    for (const weak of ["password", "changeme", "corta"]) expect(validateConfig(withSmtp({ pass: weak })).join()).toContain("SMTP_PASS es una contrasena debil");
  });

  test("las credenciales SMTP nunca viajan sin cifrar fuera de local (SMTP_SECURITY=none)", () => {
    expect(validateConfig(withSmtp({ security: "none" })).join()).toContain("SMTP_SECURITY=none no se permite");
    expect(validateConfig(withSmtp({ security: "tls", port: 465 }))).toEqual([]);
  });

  test("puerto, seguridad y plazo SMTP deben ser validos", () => {
    const problems = validateConfig(withSmtp({ port: 0, security: "maybe", timeoutMs: -1 })).join("\n");
    expect(problems).toContain("SMTP_PORT");
    expect(problems).toContain("SMTP_SECURITY debe ser tls, starttls o none");
    expect(problems).toContain("SMTP_TIMEOUT_MS");
  });

  test("Mongo y RabbitMQ fuera de local exigen TLS y sin contrasenas por defecto", () => {
    const problems = validateConfig(prod({ mongoUri: cred("mongodb", "admin", "admin", "mongo:27017/x"), rabbitUri: cred("amqp", "guest", "guest", "broker:5672") })).join("\n");
    expect(problems).toContain("MONGO_URI debe usar TLS");
    expect(problems).toContain("RABBITMQ_URI debe usar amqps://");
    expect(problems).toContain("contrasena debil");
  });

  test("el mensaje de error nunca contiene el valor de un secreto", () => {
    try {
      assertValidConfig(withSmtp({ pass: "password" }));
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.message).not.toContain('"password"');
      expect(e.message).not.toMatch(/SMTP_PASS es una contrasena debil.*password/);
    }
  });

  test("NOTIFICATION_STALE_CLAIM_MS debe ser un entero positivo", () => {
    expect(validateConfig(prod({ staleClaimMs: 0 })).join()).toContain("NOTIFICATION_STALE_CLAIM_MS");
  });

  test("SMS_TRANSPORT=console se acepta, incluso fuera de local (sin proveedor real todavia)", () => {
    expect(validateConfig(prod({ sms: { transport: "console" } }))).toEqual([]);
  });

  test("un SMS_TRANSPORT desconocido se rechaza", () => {
    expect(validateConfig(prod({ sms: { transport: "twilio" } })).join()).toContain("SMS_TRANSPORT debe ser uno de");
  });
});

describe("arranque de ms-notificaciones (env.js)", () => {
  const MANAGED = ["NODE_ENV", "EMAIL_TRANSPORT", "MAIL_FROM", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURITY", "SMS_TRANSPORT", "MONGO_URI", "RABBITMQ_URI", "NOTIFICATION_STALE_CLAIM_MS"];
  function loadEnvWith(vars) {
    const saved = { ...process.env };
    for (const k of MANAGED) delete process.env[k];
    Object.assign(process.env, vars);
    try {
      let cfg;
      jest.isolateModules(() => {
        cfg = require("../src/config/env");
      });
      return cfg;
    } finally {
      process.env = saved;
    }
  }

  test("NODE_ENV ausente o vacio falla cerrado", () => {
    expect(() => loadEnvWith({})).toThrow(/NODE_ENV es obligatorio/);
    expect(() => loadEnvWith({ NODE_ENV: "" })).toThrow(/NODE_ENV es obligatorio/);
  });

  test("en development arranca con console, sin SMTP y con el remitente por defecto", () => {
    const cfg = loadEnvWith({ NODE_ENV: "development" });
    expect(cfg.mail.transport).toBe("console");
    expect(cfg.mail.from).toBe("no-responder@carpetacolombia.co");
    expect(cfg.sms.transport).toBe("console");
    expect(cfg.staleClaimMs).toBe(60000);
  });

  test("en produccion el transporte por defecto es smtp y sin credenciales NO arranca", () => {
    expect(() => loadEnvWith({ NODE_ENV: "production", RABBITMQ_URI: cred("amqps", "svc", "Zq8mV2nX9pLr", "b:5671"), MONGO_URI: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "c.net/x") })).toThrow(/SMTP_HOST es obligatorio/);
  });

  test("en produccion con console explicito tampoco arranca", () => {
    expect(() => loadEnvWith({ NODE_ENV: "production", EMAIL_TRANSPORT: "console", RABBITMQ_URI: cred("amqps", "svc", "Zq8mV2nX9pLr", "b:5671"), MONGO_URI: cred("mongodb+srv", "svc", "Zq8mV2nX9pLr", "c.net/x") })).toThrow(/EMAIL_TRANSPORT debe ser smtp/);
  });
});

describe("salud (HT-01)", () => {
  test("/health responde 200 siempre; /ready segun el estado", async () => {
    let ready = false;
    const app = buildApp({ isReady: () => ready });

    await request(app).get("/health").expect(200, { status: "ok" });
    await request(app).get("/ready").expect(503);
    ready = true;
    await request(app).get("/ready").expect(200, { status: "ready" });
  });

  test("devuelve el x-trace-id y no anuncia el framework", async () => {
    const res = await request(buildApp()).get("/health").set("x-trace-id", "traza-cliente-0001");
    expect(res.headers["x-trace-id"]).toBe("traza-cliente-0001");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
