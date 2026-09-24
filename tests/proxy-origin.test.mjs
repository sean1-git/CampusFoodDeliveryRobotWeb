import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createRequestUrlResolver, InvalidRequestUrl } from "../server/request-url.mjs";
import { canonicalOrigin } from "../server/origin.mjs";
import { handleApi } from "../server/api.mjs";
import { openDatabase } from "../server/local-db.mjs";
import { studentSession } from "./student-fixture.mjs";

const incoming = (headers = {}, options = {}) => ({
  url: "/api/orders?view=recent", headers: { host: "store.example", ...headers },
  socket: { remoteAddress: "10.0.0.5", encrypted: false }, ...options,
});

test("direct HTTP and TLS requests retain their transport protocol without trusting forwarded headers", () => {
  const resolve = createRequestUrlResolver();
  assert.equal(resolve(incoming({ "x-forwarded-proto": "https" })).origin, "http://store.example");
  assert.equal(resolve(incoming({ "x-forwarded-proto": "http" }, {
    socket: { encrypted: true, remoteAddress: "10.0.0.5" },
  })).origin, "https://store.example");
  assert.equal(resolve(incoming({ host: "localhost:5173" })).origin, "http://localhost:5173");
  assert.equal(resolve(incoming({ host: "[::1]:8787" })).origin, "http://[::1]:8787");
});

test("trusted proxy protocol reconstructs external HTTPS while preserving path/query", () => {
  const resolve = createRequestUrlResolver({ TRUST_PROXY: "true" });
  assert.equal(resolve(incoming({ "x-forwarded-proto": "https" })).href,
    "https://store.example/api/orders?view=recent");
  assert.equal(resolve(incoming({ "x-forwarded-proto": "http" })).protocol, "http:");
  assert.equal(resolve(incoming()).protocol, "http:");
});

test("explicit peer trust does not use X-Forwarded-For to decide who is trusted", () => {
  const resolve = createRequestUrlResolver({ TRUST_PROXY: "10.0.0.5,::1" });
  assert.equal(resolve(incoming({ "x-forwarded-proto": "https" })).protocol, "https:");
  assert.equal(resolve(incoming({ "x-forwarded-proto": "https", "x-forwarded-for": "10.0.0.5" }, {
    socket: { remoteAddress: "10.0.0.6" },
  })).protocol, "http:");
  const local = createRequestUrlResolver({ TRUST_PROXY: "loopback" });
  for (const address of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(local(incoming({ "x-forwarded-proto": "https" }, {
      socket: { remoteAddress: address },
    })).protocol, "https:");
  }
  assert.equal(local(incoming({ "x-forwarded-proto": "https" })).protocol, "http:");
});

test("canonical origin overrides internal hosts, forwarded headers, and browser Origin", () => {
  const resolve = createRequestUrlResolver({ CANONICAL_ORIGIN: "https://campus.example/", NODE_ENV: "production" });
  const url = resolve(incoming({ host: "internal:8080", origin: "https://attacker.example",
    "x-forwarded-proto": "http,https", "x-forwarded-host": "attacker.example",
    forwarded: "proto=http;host=attacker.example" }));
  assert.equal(url.href, "https://campus.example/api/orders?view=recent");
});

test("malformed trusted protocol values and ambiguous header lists fail closed", () => {
  const resolve = createRequestUrlResolver({ TRUST_PROXY: "true" });
  for (const value of ["https,http", "http, https", "ftp", "javascript", "", ["https", "http"], "HTTPS", " https"]) {
    assert.throws(() => resolve(incoming({ "x-forwarded-proto": value })), InvalidRequestUrl);
  }
  // Untrusted headers cannot cause rejection or change how direct URLs are built.
  assert.equal(createRequestUrlResolver()(incoming({ "x-forwarded-proto": "garbage" })).protocol, "http:");
});

test("request targets cannot replace the origin and host headers cannot inject URL credentials/paths", () => {
  for (const env of [{}, { CANONICAL_ORIGIN: "https://campus.example" }]) {
    const resolve = createRequestUrlResolver(env);
    for (const url of ["https://attacker.example/api/orders", "//attacker.example/api/orders", "/\\attacker.example", "/api/#fragment", "/api/ bad", undefined]) {
      assert.throws(() => resolve(incoming({}, { url })), InvalidRequestUrl);
    }
  }
  const resolve = createRequestUrlResolver();
  for (const host of [undefined, "", "user@evil.example", "evil.example/path", "evil.example?x", "bad host", "example:99999", ["a", "b"]]) {
    assert.throws(() => resolve(incoming({ host })), InvalidRequestUrl);
  }
  assert.equal(resolve(incoming({ "x-forwarded-host": "evil.example", origin: "https://evil.example" })).host, "store.example");
});

test("invalid deployment configuration fails at startup and production canonical origin requires HTTPS", () => {
  for (const origin of ["not-a-url", "ftp://campus.example", "https://user:pass@campus.example", "https://campus.example/path", "https://campus.example?x=1", "https://campus.example/#frag", "https://campus.example/path/..", "https://campus.example?", "https://campus.example\\", " https://campus.example"]) {
    assert.throws(() => createRequestUrlResolver({ CANONICAL_ORIGIN: origin }));
  }
  assert.throws(() => createRequestUrlResolver({ CANONICAL_ORIGIN: "http://campus.example", NODE_ENV: "production" }));
  assert.equal(canonicalOrigin("http://localhost:8787"), "http://localhost:8787");
  assert.equal(canonicalOrigin("https://campus.example:443/", true), "https://campus.example");
  assert.throws(() => createRequestUrlResolver({ TRUST_PROXY: "maybe" }));
});

test("HTTPS proxy URL passes origin validation without weakening student authentication or CSRF", async (t) => {
  const DB = openDatabase();
  t.after(() => DB.close());
  const student = await studentSession(DB);
  const resolve = createRequestUrlResolver({ TRUST_PROXY: "10.0.0.5" });
  const url = resolve(incoming({ "x-forwarded-proto": "https" }));
  const send = (headers = {}, env = {}) => handleApi(new Request(url, {
    method: "POST", headers: { origin: "https://store.example", cookie: student.cookie,
      "x-csrf-token": student.csrf, "idempotency-key": crypto.randomUUID(), "content-type": "application/json", ...headers },
    body: JSON.stringify({ items: [{ id: "sandwich", quantity: 1 }], location: "Library entrance" }),
  }), { DB, ...env });
  assert.equal((await send({ origin: "http://store.example" })).status, 403);
  assert.equal((await send({ origin: "https://attacker.example" })).status, 403);
  assert.equal((await send({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await send({ "x-csrf-token": "bad" })).status, 403);
  assert.equal((await send({ cookie: "" })).status, 401);
  const result = await send();
  assert.ok([201, 202].includes(result.status));
});

test("shared API canonical origin replaces rather than supplements the internal request origin", async (t) => {
  const DB = openDatabase();
  t.after(() => DB.close());
  const env = { DB, CANONICAL_ORIGIN: "https://campus.example", NODE_ENV: "production" };
  const send = (origin, extra = {}) => handleApi(new Request("http://internal:8080/api/orders", {
    method: "POST", headers: { origin },
  }), { ...env, ...extra });
  // 401 means origin validation passed, but student login is still required.
  assert.equal((await send("https://campus.example")).status, 401);
  assert.equal((await send("http://internal:8080")).status, 403);
  assert.equal((await send("http://localhost:5173")).status, 403);
  assert.equal((await send("https://frontend.example", { ALLOWED_ORIGINS: "https://frontend.example" })).status, 401);
});

test("real Node HTTP forwarding produces HTTPS API requests and rejects ambiguous protocols", async (t) => {
  const DB = openDatabase();
  const resolve = createRequestUrlResolver({ TRUST_PROXY: "loopback" });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = resolve(incoming);
      const response = await handleApi(new Request(url, { method: incoming.method, headers: incoming.headers }), { DB });
      outgoing.writeHead(response.status);
      outgoing.end(await response.text());
    } catch (error) {
      outgoing.writeHead(error instanceof InvalidRequestUrl ? 400 : 500);
      outgoing.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); DB.close(); });
  const send = (proto, origin) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: server.address().port, path: "/api/orders", method: "POST",
      headers: { host: "campus.example", "x-forwarded-proto": proto, origin }, agent: false,
    }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    req.on("error", reject); req.end();
  });
  assert.equal(await send("https", "https://campus.example"), 401);
  assert.equal(await send("https", "http://campus.example"), 403);
  assert.equal(await send("https, http", "https://campus.example"), 400);
});
