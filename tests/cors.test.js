const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp, isOriginAllowed } = require("../src/app");

const fakeDb = { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }), runTransaction: async () => ({}) };

test("origin rules", () => {
  const list = { allowedOrigins: ["https://shop.example.com"], allowLanOrigins: false };
  assert.equal(isOriginAllowed(undefined, list), true);                       // no Origin header
  assert.equal(isOriginAllowed("https://shop.example.com", list), true);
  assert.equal(isOriginAllowed("https://shop.example.com/", list), true);     // trailing slash
  assert.equal(isOriginAllowed("http://192.168.1.20:3000", list), false);     // LAN off
  assert.equal(isOriginAllowed("https://evil.example.org", list), false);

  const dev = { allowedOrigins: ["http://localhost:3000"], allowLanOrigins: true };
  for (const o of ["http://192.168.1.20:3000", "http://10.0.0.5:3000", "http://172.20.1.9:5173", "http://localhost:5173", "http://127.0.0.1:3000", "http://mypc.local:3000"]) {
    assert.equal(isOriginAllowed(o, dev), true, o);
  }
  assert.equal(isOriginAllowed("http://8.8.8.8:3000", dev), false);           // public IP stays blocked
  assert.equal(isOriginAllowed("http://172.32.0.1:3000", dev), false);        // outside 172.16-31
  assert.equal(isOriginAllowed("https://evil.example.org", dev), false);
  assert.equal(isOriginAllowed("https://anything.com", { allowedOrigins: ["*"] }), true);
  assert.equal(isOriginAllowed("https://anything.com", { allowedOrigins: [] }), true);
});

function request(server, { method, path, headers }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("browser preflight from another PC on the network is answered with CORS headers", async () => {
  const app = createApp({ db: fakeDb, sms: {}, mailer: {}, allowedOrigins: ["http://localhost:3000"], allowLanOrigins: true });
  const server = app.listen(0);
  try {
    const r = await request(server, {
      method: "OPTIONS",
      path: "/api/register",
      headers: {
        Origin: "http://192.168.1.20:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.ok(r.status === 204 || r.status === 200);
    assert.equal(r.headers["access-control-allow-origin"], "http://192.168.1.20:3000");
    assert.match(r.headers["access-control-allow-methods"], /POST/);
    assert.match(r.headers["access-control-allow-headers"], /content-type/i);
    assert.equal(r.headers["access-control-allow-private-network"], "true");

    const get = await request(server, { method: "GET", path: "/health", headers: { Origin: "http://192.168.1.20:3000" } });
    assert.equal(get.headers["access-control-allow-origin"], "http://192.168.1.20:3000");
  } finally {
    server.close();
  }
});

test("an unknown public website gets no CORS permission", async () => {
  const app = createApp({ db: fakeDb, sms: {}, mailer: {}, allowedOrigins: ["http://localhost:3000"], allowLanOrigins: true });
  const server = app.listen(0);
  try {
    const r = await request(server, { method: "GET", path: "/health", headers: { Origin: "https://evil.example.org" } });
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  } finally {
    server.close();
  }
});