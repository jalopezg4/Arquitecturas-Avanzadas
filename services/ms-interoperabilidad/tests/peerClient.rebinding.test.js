/**
 * HU-05c: la defensa contra DNS rebinding de PeerOperatorClient, probada DE EXTREMO A EXTREMO con axios real y un
 * servidor HTTP real. El nombre `operador-falso.example.co` no existe en el DNS: un resolvedor falso lo apunta a
 * 127.0.0.1 (lo que haria un atacante que controla su DNS). Si la peticion llega al servidor, axios uso nuestro
 * `lookup`; si la politica esta activa, no debe llegar nada.
 */
const http = require("http");
const { PeerOperatorClient } = require("../src/infrastructure/PeerOperatorClient");

const HOST = "operador-falso.example.co";
let server;
let port;
let hits;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  hits = [];
});

/** Resolvedor falso: el nombre publico "resuelve" a loopback. */
const resolve = jest.fn((hostname, options, callback) => {
  if (hostname !== HOST) return callback(new Error(`ENOTFOUND ${hostname}`));
  return callback(null, [{ address: "127.0.0.1", family: 4 }]);
});

test("axios usa nuestro lookup: con la politica relajada (solo local) el nombre llega al servidor", async () => {
  const client = new PeerOperatorClient({ allowPrivate: true, resolve, timeoutMs: 2000 });

  await expect(client.post(`http://${HOST}:${port}/api/transferCitizen`, { id: 1 })).resolves.toMatchObject({ status: 200 });

  expect(resolve).toHaveBeenCalled();
  expect(hits).toEqual(["POST /api/transferCitizen"]);
});

test("con la politica activa, un nombre publico que RESUELVE a una IP privada se bloquea al conectar (nada llega)", async () => {
  const client = new PeerOperatorClient({ allowPrivate: false, resolve, timeoutMs: 2000 });

  await expect(client.post(`http://${HOST}:${port}/api/transferCitizen`, { id: 1 })).rejects.toMatchObject({ definitive: true, message: expect.stringMatching(/local o privada/) });

  expect(hits).toEqual([]);
});
