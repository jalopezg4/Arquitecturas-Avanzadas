const { assertSafeTransferUrl, UnsafeTransferUrlError } = require("../src/security/transferUrl");

const rejects = (url, options) => expect(() => assertSafeTransferUrl(url, options)).toThrow(UnsafeTransferUrlError);

describe("assertSafeTransferUrl() -- la direccion la publica OTRO operador (no confiable)", () => {
  test.each([
    ["http://operador.co/api/transferCitizen", "http://operador.co/api/transferCitizen"],
    ["https://operador.co:8443/api/transferCitizen", "https://operador.co:8443/api/transferCitizen"],
    [" http://operador.co/api/transferCitizen ", "http://operador.co/api/transferCitizen"], // el espacio inicial es real en el sandbox
    ["http://8.8.8.8/x", "http://8.8.8.8/x"],
    ["http://[2001:4860:4860::8888]/x", "http://[2001:4860:4860::8888]/x"],
    ["HTTP://OPERADOR.CO/A", "http://operador.co/A"], // se normaliza
  ])("acepta %j", (input, normalized) => {
    expect(assertSafeTransferUrl(input)).toBe(normalized);
  });

  test.each([
    ["esquema file", "file:///etc/passwd"],
    ["esquema javascript", "javascript:alert(1)"],
    ["esquema ftp", "ftp://operador.co/x"],
    ["esquema gopher", "gopher://operador.co/x"],
    ["data URL", "data:text/plain;base64,QQ=="],
    ["sin esquema", "operador.co/api"],
    ["vacia", ""],
    ["solo espacios", "   "],
    ["no es texto", null],
    ["numero", 42],
    ["con espacios en medio", "http://operador.co/a b"],
    ["salto de linea (inyeccion)", "http://operador.co/a\r\nHost: evil"],
    ["caracter de control", "http://operador.co/ab"],
    ["credenciales en la URL", "http://admin:secreto@operador.co/x"],
    ["usuario sin clave", "http://admin@operador.co/x"],
    ["demasiado larga", `http://operador.co/${"x".repeat(2100)}`],
  ])("rechaza %s", (_name, url) => rejects(url));

  test.each([
    ["localhost", "http://localhost/x"],
    ["subdominio de localhost", "http://api.localhost/x"],
    ["nombre .local", "http://impresora.local/x"],
    ["nombre .internal", "http://servicio.internal/x"],
    ["nombre sin punto (host interno)", "http://intranet/x"],
    ["loopback IPv4", "http://127.0.0.1/x"],
    ["cualquier 127.x", "http://127.53.1.1/x"],
    ["0.0.0.0", "http://0.0.0.0/x"],
    ["red 10.x", "http://10.1.2.3/x"],
    ["red 172.16-31", "http://172.20.0.5/x"],
    ["red 192.168", "http://192.168.1.10/x"],
    ["metadatos de la nube (link-local)", "http://169.254.169.254/latest/meta-data/"],
    ["CGNAT 100.64", "http://100.64.0.1/x"],
    ["multicast/reservado", "http://240.0.0.1/x"],
    ["IPv4 en decimal (2130706433 = 127.0.0.1)", "http://2130706433/x"],
    ["IPv4 en hexadecimal", "http://0x7f000001/x"],
    ["IPv4 abreviada 127.1", "http://127.1/x"],
    ["IPv4 en octal", "http://0177.0.0.1/x"],
    ["loopback IPv6", "http://[::1]/x"],
    ["IPv6 no especificada", "http://[::]/x"],
    ["IPv6 unique-local", "http://[fd12:3456:789a::1]/x"],
    ["IPv6 link-local", "http://[fe80::1]/x"],
    ["IPv4 mapeada a IPv6 (127.0.0.1)", "http://[::ffff:127.0.0.1]/x"],
    ["IPv4 mapeada en hexadecimal", "http://[::ffff:7f00:1]/x"],
    ["IPv4 mapeada privada 10.x", "http://[::ffff:a00:1]/x"],
    ["con punto final", "http://localhost./x"],
  ])("rechaza (SSRF) %s", (_name, url) => rejects(url));

  test("allowPrivate (solo desarrollo) permite localhost y redes privadas, pero NO cambia lo demas", () => {
    expect(assertSafeTransferUrl("http://localhost:9000/x", { allowPrivate: true })).toBe("http://localhost:9000/x");
    expect(assertSafeTransferUrl("http://192.168.1.10/x", { allowPrivate: true })).toBe("http://192.168.1.10/x");
    rejects("file:///etc/passwd", { allowPrivate: true });
    rejects("http://a:b@localhost/x", { allowPrivate: true });
  });

  test("requireHttps rechaza http", () => {
    rejects("http://operador.co/x", { requireHttps: true });
    expect(assertSafeTransferUrl("https://operador.co/x", { requireHttps: true })).toBe("https://operador.co/x");
  });

  test("el error explica el motivo pero no repite la URL completa", () => {
    try {
      assertSafeTransferUrl("http://admin:secreto@operador.co/x");
    } catch (e) {
      expect(e.reason).toMatch(/credenciales/);
      expect(e.message).not.toContain("secreto");
    }
  });
});
