import test from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../server/api.mjs";
import { openDatabase } from "../server/local-db.mjs";
import { DEMO_ISSUER, SESSION_AGE } from "../server/auth.mjs";

const origin = "https://campus.test";
const basket = { items: [{ id: "coffee", quantity: 1 }], location: "Library Walk", destination: { lat: 37.365562, lng: -120.424938, confirmed: true } };
function setup(t) {
  const DB = openDatabase();
  t.after(() => DB.close());
  const call = (path, { user, method = "GET", body, headers = {}, mode = "demo", now = Date.now(), key = crypto.randomUUID() } = {}) => handleApi(new Request(origin + path, {
    method, headers: { origin, "content-type": "application/json", "idempotency-key": key,
      ...(user ? { cookie: user.cookie, "x-csrf-token": user.csrf } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { DB, INTEGRATION_MODE: mode }, now);
  const visitor = async () => {
    const response = await call("/api/session");
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
    return { ...(await response.json()), cookie: cookie.split(";")[0] };
  };
  return { DB, call, visitor };
}

test("a visitor can reserve and confirm with no SSO; reload retains the wallet and purchase", async (t) => {
  const { call, visitor, DB } = setup(t);
  const user = await visitor();
  assert.equal(user.balanceCents, 5000);
  const account = await DB.prepare("SELECT kind, issuer FROM accounts WHERE id = ?").bind(user.accountId).first();
  assert.equal(account.kind, "legacy");
  assert.equal(account.issuer, DEMO_ISSUER);
  const key = crypto.randomUUID();
  const held = await call("/api/reservations", { user, method: "POST", key, body: basket });
  assert.equal((await held.json()).status, "held");
  assert.equal((await (await call("/api/session", { user })).json()).balanceCents, 5000);
  const confirmed = await call(`/api/reservations/${key}/confirm`, { user, method: "POST" });
  assert.equal(confirmed.status, 201);
  const order = await confirmed.json();
  const retry = await call(`/api/reservations/${key}/confirm`, { user, method: "POST" });
  assert.equal((await retry.json()).id, order.id);
  const reload = await call("/api/session", { user });
  assert.equal(reload.headers.has("set-cookie"), false);
  const wallet = await reload.json();
  assert.equal(wallet.accountId, user.accountId);
  assert.equal(wallet.balanceCents, 4525);
  assert.ok(wallet.nextOrderAt > Date.now());
  assert.equal((await (await call("/api/orders", { user })).json()).orders.length, 1);
});

test("separate visitors cannot see or confirm another visitor's held checkout", async (t) => {
  const { call, visitor } = setup(t);
  const a = await visitor(), b = await visitor(), key = crypto.randomUUID();
  assert.notEqual(a.accountId, b.accountId);
  await call("/api/reservations", { user: a, method: "POST", key, body: basket });
  assert.equal((await call(`/api/checkouts/${key}`, { user: b })).status, 404);
  assert.equal((await call(`/api/reservations/${key}/confirm`, { user: b, method: "POST" })).status, 404);
  assert.equal((await call(`/api/reservations/${key}/confirm`, { user: a, method: "POST", headers: { "x-csrf-token": "wrong" } })).status, 403);
  assert.equal((await call(`/api/reservations/${key}/confirm`, { user: a, method: "POST", headers: { origin: "https://attacker.test" } })).status, 403);
});

test("missing/expired cookies never place orders; only session bootstrap creates a new demo account", async (t) => {
  const { call, visitor } = setup(t);
  assert.equal((await call("/api/orders", { method: "POST", body: basket })).status, 401);
  const user = await visitor();
  const expiredAt = Date.now() + SESSION_AGE + 1;
  assert.equal((await call("/api/orders", { user, method: "POST", body: basket, now: expiredAt })).status, 401);
  const bootstrap = await call("/api/session", { user, now: expiredAt, headers: { "x-student-id": "admin", "x-account-id": user.accountId } });
  assert.equal(bootstrap.status, 200);
  const renewed = await bootstrap.json();
  assert.notEqual(renewed.accountId, user.accountId);
  assert.equal(renewed.balanceCents, 5000);
});

test("live mode and cross-site bootstraps cannot create demo accounts", async (t) => {
  const { call, DB } = setup(t);
  assert.equal((await call("/api/session", { mode: "live" })).status, 503);
  assert.equal((await call("/api/session", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await call("/api/session", { headers: { origin: "https://attacker.test" } })).status, 403);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM accounts").first()).n, 0);
});


test("combined bootstrap sets the cookie and only returns the visitor's own orders", async (t) => {
  const { call, visitor } = setup(t);
  const first = await call("/api/session?include=orders");
  assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie"), /HttpOnly/);
  assert.match(first.headers.get("cache-control"), /no-store/);
  assert.deepEqual((await first.json()).orders, []);
  const a = await visitor(), b = await visitor();
  const purchase = await call("/api/orders", { user: a, method: "POST", body: basket });
  assert.equal(purchase.status, 201);
  const order = await purchase.json();
  const now = Date.now();
  const bundled = await (await call("/api/session?include=orders", { user: a, now })).json();
  const separate = await (await call("/api/orders", { user: a, now })).json();
  assert.deepEqual(bundled.orders, separate.orders);
  assert.equal(bundled.orders[0].id, order.id);
  assert.equal(bundled.balanceCents, 4525);
  assert.deepEqual((await (await call("/api/session?include=orders", { user: b })).json()).orders, []);
});
