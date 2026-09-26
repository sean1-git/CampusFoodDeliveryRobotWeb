import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/local-db.mjs";
import { handleApi } from "../server/api.mjs";
import { ensureInventory, availableInventory, HOLD_MS } from "../server/inventory.mjs";
import { studentSession } from "./student-fixture.mjs";

const origin = "https://campus.test";
const body = { items: [{ id: "sandwich", quantity: 1 }], location: "Library Walk", destination: { lat: 37.364864, lng: -120.425233, confirmed: true } };
async function fixture(t) {
  const DB = openDatabase();
  t.after(() => DB.close());
  await ensureInventory(DB);
  await DB.prepare("UPDATE inventory SET quantity = 1 WHERE product_id = 'sandwich'").run();
  const users = [];
  for (let i = 0; i < 2; i++) {
    users.push(await studentSession(DB));
  }
  async function call(user, path, { method = "GET", payload, key = crypto.randomUUID(), now = Date.now(), csrf = user.csrf } = {}) {
    const response = await handleApi(new Request(origin + path, {
      method, headers: { cookie: user.cookie, origin, "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": key },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }), { DB }, now);
    return { status: response.status, body: await response.json() };
  }
  async function reserve(user = users[0], key = crypto.randomUUID(), payload = body) {
    let result = await call(user, "/api/reservations", { method: "POST", payload, key });
    while (result.status === 202) {
      await new Promise((r) => setTimeout(r, 100));
      result = await call(user, `/api/checkouts/${key}`);
    }
    return { ...result, key };
  }
  return { DB, users, call, reserve };
}

test("entering checkout holds the last unit without charging; other buyers cannot buy it", async (t) => {
  const f = await fixture(t), hold = await f.reserve();
  assert.equal(hold.body.status, "held");
  assert.ok(hold.body.expiresAt - hold.body.serverNow <= HOLD_MS);
  assert.equal((await availableInventory(f.DB)).get("sandwich"), 0);
  assert.equal((await f.call(f.users[0], "/api/session")).body.balanceCents, 5000);
  assert.equal((await f.reserve(f.users[1])).body.code, "sold_out");
  assert.equal((await f.call(f.users[1], "/api/orders", { method: "POST", payload: body })).body.code, "sold_out");
});

test("two concurrent holds on the last unit have one winner", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(f.users.map((u) => f.reserve(u)));
  assert.equal(results.filter((r) => r.body.status === "held").length, 1);
  assert.equal(results.filter((r) => r.body.code === "sold_out").length, 1);
});

test("expiry releases every item without a timer/cleanup request, and late confirmation fails", async (t) => {
  const f = await fixture(t), hold = await f.reserve(f.users[0], crypto.randomUUID(), {
    ...body, items: [...body.items, { id: "coffee", quantity: 2 }],
  });
  assert.equal((await availableInventory(f.DB, hold.body.expiresAt - 1)).get("sandwich"), 0);
  const after = await availableInventory(f.DB, hold.body.expiresAt);
  assert.equal(after.get("sandwich"), 1);
  assert.equal(after.get("coffee"), 20);
  const late = await f.call(f.users[0], `/api/reservations/${hold.key}/confirm`, { method: "POST", now: hold.body.expiresAt });
  assert.equal(late.status, 410);
  assert.equal(late.body.code, "expired");
  assert.equal((await f.call(f.users[0], "/api/session")).body.balanceCents, 5000);
});

test("reload/status polls and duplicate reservation requests never extend the expiry", async (t) => {
  const f = await fixture(t), hold = await f.reserve();
  const again = await f.reserve(f.users[0], hold.key);
  const poll = await f.call(f.users[0], `/api/checkouts/${hold.key}`, { now: hold.body.expiresAt - 1 });
  assert.equal(again.body.expiresAt, hold.body.expiresAt);
  assert.equal(poll.body.expiresAt, hold.body.expiresAt);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM checkout_queue").first()).n, 1);
});

test("confirming a hold allocates and charges once, and expiry never cancels a completed order", async (t) => {
  const f = await fixture(t), hold = await f.reserve();
  const confirmations = await Promise.all(Array.from({ length: 5 }, () => f.call(f.users[0],
    `/api/reservations/${hold.key}/confirm`, { method: "POST", now: hold.body.expiresAt - 1 })));
  assert.ok(confirmations.every((r) => r.status === 201));
  assert.equal(new Set(confirmations.map((r) => r.body.id)).size, 1);
  assert.equal((await availableInventory(f.DB, hold.body.expiresAt + 1)).get("sandwich"), 0);
  assert.equal((await f.call(f.users[0], "/api/session")).body.balanceCents, 4250);
  const retry = await f.call(f.users[0], `/api/reservations/${hold.key}/confirm`, { method: "POST", now: hold.body.expiresAt + 1 });
  assert.equal(retry.body.id, confirmations[0].body.id);
});

test("cancel releases stock; cancelled checkout cannot later be purchased", async (t) => {
  const f = await fixture(t), hold = await f.reserve();
  assert.equal((await f.call(f.users[0], `/api/reservations/${hold.key}/cancel`, { method: "POST" })).body.status, "cancelled");
  assert.equal((await availableInventory(f.DB)).get("sandwich"), 1);
  assert.equal((await f.call(f.users[0], `/api/reservations/${hold.key}/confirm`, { method: "POST" })).status, 410);
  assert.equal((await f.reserve(f.users[1])).body.status, "held");
});

test("holds are session-owned, CSRF protected, and limited to one active checkout per session", async (t) => {
  const f = await fixture(t), hold = await f.reserve();
  assert.equal((await f.call(f.users[1], `/api/reservations/${hold.key}/confirm`, { method: "POST" })).status, 404);
  assert.equal((await f.call(f.users[0], `/api/reservations/${hold.key}/cancel`, { method: "POST", csrf: "wrong" })).status, 403);
  const second = await f.reserve(f.users[0], crypto.randomUUID(), { ...body, items: [{ id: "coffee", quantity: 1 }] });
  assert.equal(second.body.code, "active_reservation");
  assert.equal((await availableInventory(f.DB)).get("coffee"), 20);
});

test("simultaneous tabs cannot create two active reservations for one session", async (t) => {
  const f = await fixture(t);
  const keys = [crypto.randomUUID(), crypto.randomUUID()];
  const results = await Promise.all(keys.map((key) => f.reserve(f.users[0], key)));
  assert.deepEqual(results.map((result) => result.body.status || result.body.code).sort(), ["active_reservation", "held"]);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM checkout_queue WHERE session_id = ? AND status = 'held'").bind(f.users[0].cookie.split("=")[1]).first()).count, 1);
});

test("catalog response time does not claim a source stock change when holds expire", async (t) => {
  const f = await fixture(t), hold = await f.reserve();
  const now = hold.body.expiresAt;
  const result = await f.call(f.users[0], "/api/catalog", { now });
  assert.equal(result.body.responseGeneratedAt, now);
  assert.equal(result.body.inventoryUpdatedAt, undefined);
  assert.equal(result.body.products.find((p) => p.id === "sandwich").stockUpdatedAt, null);
  assert.equal(result.body.products.find((p) => p.id === "sandwich").syncedAt, null);
  assert.equal(result.body.products.find((p) => p.id === "sandwich").stock, 1);
});

test("legacy direct-purchase endpoint cannot bypass an account's active reservation", async (t) => {
  const f = await fixture(t), hold = await f.reserve();
  const spent = await f.call(f.users[0], "/api/orders", {
    method: "POST", payload: { ...body, items: [{ id: "coffee", quantity: 12 }] },
  });
  assert.equal(spent.status, 409);
  assert.equal(spent.body.code, "active_reservation");
  const confirmation = await f.call(f.users[0], `/api/reservations/${hold.key}/confirm`, { method: "POST" });
  assert.equal(confirmation.status, 201);
  assert.equal((await availableInventory(f.DB)).get("sandwich"), 0);
  assert.equal((await f.call(f.users[0], "/api/session")).body.balanceCents, 4250);
});

test("a purchased order blocks another order only until delivery", async (t) => {
  const f = await fixture(t);
  const first = await f.call(f.users[0], "/api/orders", { method: "POST", payload: body });
  assert.equal(first.status, 201);
  const blocked = await f.reserve(f.users[0], crypto.randomUUID(), {
    ...body,
    items: [{ id: "coffee", quantity: 1 }],
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "order_cooldown");
  assert.equal(blocked.body.retryAt, first.body.arrivesAt);
});

test("racing cancellation and confirmation produce only one terminal outcome", async (t) => {
  const f = await fixture(t), hold = await f.reserve();
  await Promise.all([
    f.call(f.users[0], `/api/reservations/${hold.key}/confirm`, { method: "POST" }),
    f.call(f.users[0], `/api/reservations/${hold.key}/cancel`, { method: "POST" }),
  ]);
  const orders = (await f.call(f.users[0], "/api/orders")).body.orders;
  assert.ok(orders.length === 0 || orders.length === 1);
  assert.equal((await availableInventory(f.DB)).get("sandwich"), orders.length ? 0 : 1);
  assert.equal((await f.call(f.users[0], "/api/session")).body.balanceCents, orders.length ? 4250 : 5000);
});
