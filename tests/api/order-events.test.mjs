import test from "node:test";
import assert from "node:assert/strict";
import { createOrderEvents, orderBoundaries } from "../../apps/api/src/orders/order-events.mjs";
import { handleApi } from "../../apps/api/src/api.mjs";
import { openDatabase } from "../../apps/api/src/database/local-db.mjs";
import { ensureInventory } from "../../apps/api/src/inventory/inventory.mjs";
import { SESSION_AGE } from "../../apps/api/src/auth/auth.mjs";
import { studentSession } from "../fixtures/student-fixture.mjs";

const origin = "https://campus.test";
const flush = () => new Promise(resolve => setImmediate(resolve));
const basket = { items: [{ id: "sandwich", quantity: 1 }], location: "Library Walk",
  destination: { lat: 37.365562, lng: -120.424938, confirmed: true } };

function scheduler(start = Date.now()) {
  let current = start, sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: current + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    size: () => timers.size,
    async advance(milliseconds) {
      const target = current + milliseconds;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        current = next[1].at;
        timers.delete(next[0]);
        await next[1].callback();
        await flush();
      }
      current = target;
      await flush();
    },
  };
}

async function fixture(t, options = {}) {
  const DB = openDatabase(), clock = scheduler(), reads = { orders: 0, auth: 0 };
  const observedDB = { ...DB, prepare(sql) {
    if (/SELECT \* FROM orders WHERE account_id/.test(sql)) reads.orders++;
    if (/SELECT s\.\* FROM sessions/.test(sql)) reads.auth++;
    return DB.prepare(sql);
  } };
  const hub = createOrderEvents({ db: observedDB, ...clock, ...options });
  const streams = [];
  t.after(async () => { hub.close(); await Promise.all(streams.map(stream => stream.stop())); DB.close(); });
  const a = await studentSession(DB, "events-a", clock.now());
  const b = await studentSession(DB, "events-b", clock.now());
  const call = (user, path, init = {}, env = {}) => handleApi(new Request(origin + path, {
    ...init, headers: { ...(user ? { cookie: user.cookie, "x-csrf-token": user.csrf } : {}), origin,
      "content-type": "application/json", ...init.headers },
  }), { DB: observedDB, ORDER_EVENTS: hub, ...env }, clock.now());
  async function connect(user, init = {}, path = "/api/events") {
    const response = await call(user, path, init);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const reader = response.body.getReader();
    let text = "", closed = false;
    const pumping = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { closed = true; return; }
        text += new TextDecoder().decode(value);
      }
    })();
    const stream = { names: () => [...text.matchAll(/^event: (.+)$/gm)].map(match => match[1]),
      text: () => text, closed: () => closed, async stop() { await reader.cancel(); await pumping; } };
    streams.push(stream);
    await flush();
    return stream;
  }
  return { DB, clock, reads, hub, a, b, call, connect };
}

async function insertOrder(DB, user, createdAt, route) {
  const id = crypto.randomUUID();
  await DB.prepare(`INSERT INTO orders
    (id, session_id, account_id, request_key, request_hash, items, subtotal, total, location, created_at, delivery_route)
    VALUES (?, ?, ?, ?, 'fixture', '[]', 0, 0, 'Saved campus pin', ?, ?)`)
    .bind(id, user.id, user.account_id, crypto.randomUUID(), createdAt, route ? JSON.stringify(route) : null).run();
  return id;
}

test("events require an existing cookie session and reject cross-origin and cross-site requests", async t => {
  const f = await fixture(t);
  const sessionsBefore = (await f.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).count;
  assert.equal((await f.call(null, "/api/events")).status, 401);
  assert.equal((await f.call(null, "/api/events?csrf=pretend&accountId=other")).status, 401);
  assert.equal((await f.call(f.a, "/api/events", { headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await f.call(f.a, "/api/events", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await f.call(f.a, "/api/events", {}, { ORDER_EVENTS: undefined })).status, 501);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).count, sessionsBefore);
  assert.equal(f.clock.size(), 0);
});

test("subscribers receive only their cookie account invalidations and no private order data", async t => {
  const f = await fixture(t);
  const a = await f.connect(f.a, {}, `/api/events?accountId=${f.b.account_id}`), b = await f.connect(f.b);
  assert.deepEqual(a.names(), ["ready"]);
  await f.hub.publish(f.b.account_id); await flush();
  assert.deepEqual(a.names(), ["ready"]);
  assert.deepEqual(b.names(), ["ready", "change"]);
  await f.hub.publish(f.a.account_id); await flush();
  assert.deepEqual(a.names(), ["ready", "change"]);
  assert.doesNotMatch(a.text() + b.text(), new RegExp(`${f.a.account_id}|${f.b.account_id}|sandwich|latitude|csrf`));
  assert.ok([...a.text().matchAll(/^data: (.+)$/gm)].every(match => match[1] === "{}"));
});

test("successful checkout mutations invalidate once; reads and rejected mutations stay silent", async t => {
  const f = await fixture(t), stream = await f.connect(f.a), other = await f.connect(f.b);
  const key = crypto.randomUUID();
  let response = await f.call(f.a, "/api/reservations", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(basket) });
  for (let attempt = 0; response.status === 202 && attempt < 10; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    response = await f.call(f.a, `/api/checkouts/${key}`);
  }
  assert.equal((await response.json()).status, "held");
  await flush();
  assert.deepEqual(stream.names(), ["ready", "change"]);
  await f.call(f.a, "/api/session?include=orders");
  await f.call(f.a, "/api/orders");
  await f.call(f.a, `/api/checkouts/${key}`);
  await flush();
  assert.deepEqual(stream.names(), ["ready", "change"]);
  assert.equal((await f.call(f.a, `/api/reservations/${key}/confirm`, { method: "POST", headers: { "x-csrf-token": "wrong" } })).status, 403);
  assert.equal((await f.call(f.a, `/api/reservations/${key}/confirm`, { method: "POST" })).status, 201);
  await flush();
  assert.deepEqual(stream.names(), ["ready", "change", "change"]);
  assert.deepEqual(other.names(), ["ready"]);
});

test("GET recovery notifies all newly accepted queued accounts without a repeated-read feedback loop", async t => {
  const f = await fixture(t), a = await f.connect(f.a), b = await f.connect(f.b);
  await ensureInventory(f.DB);
  async function enqueue(user) {
    const key = crypto.randomUUID();
    await f.DB.prepare(`INSERT INTO checkout_queue
      (session_id, account_id, request_key, request_hash, order_id, items, subtotal, total, location, ready_at)
      VALUES (?, ?, ?, 'fixture', ?, ?, 650, 750, 'Library entrance', ?)`)
      .bind(user.id, user.account_id, key, crypto.randomUUID(), JSON.stringify([{ id: "sandwich", name: "Sandwich", priceCents: 650, quantity: 1 }]), f.clock.now() + 1000).run();
    return key;
  }
  const keyA = await enqueue(f.a), keyB = await enqueue(f.b);
  assert.equal((await f.call(f.a, `/api/checkouts/${keyA}`)).status, 202);
  await flush();
  assert.deepEqual(a.names(), ["ready"]);
  assert.deepEqual(b.names(), ["ready"]);
  await f.clock.advance(1000);
  assert.equal((await f.call(f.a, `/api/checkouts/${keyA}`)).status, 201);
  await flush();
  assert.deepEqual(a.names(), ["ready", "change"]);
  assert.deepEqual(b.names(), ["ready", "change"]);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM orders").first()).count, 2);
  await f.call(f.a, `/api/checkouts/${keyA}`);
  await f.call(f.b, `/api/checkouts/${keyB}`);
  await flush();
  assert.deepEqual(a.names(), ["ready", "change"]);
  assert.deepEqual(b.names(), ["ready", "change"]);
  const reads = f.reads.orders;
  await f.clock.advance(20000); // Legacy dispatch boundary, loaded after acceptance.
  assert.deepEqual(a.names(), ["ready", "change", "change"]);
  assert.deepEqual(b.names(), ["ready", "change", "change"]);
  assert.equal(f.reads.orders, reads);
});

test("saved preparation, pickup, travel and delivery boundaries emit without polling orders", async t => {
  const f = await fixture(t), created = f.clock.now();
  const route = { version: "historical-test", seconds: 25, meters: 15, points: [],
    destination: { lat: 37.363, lng: -120.427, confirmed: true }, label: "Saved pin",
    pickups: [{ id: "library", name: "Bobcat", arrivalSeconds: 0, departureSeconds: 5 },
      { id: "summits", name: "Summit", arrivalSeconds: 15, departureSeconds: 20 }],
    journey: [{ points: [], startsAtSeconds: 5, seconds: 10 }, { points: [], startsAtSeconds: 20, seconds: 5 }] };
  await insertOrder(f.DB, f.a, created, route);
  const stream = await f.connect(f.a);
  const initialReads = f.reads.orders;
  await f.clock.advance(19999);
  assert.deepEqual(stream.names(), ["ready"]);
  for (const milliseconds of [1, 5000, 10000, 5000, 5000]) {
    const changes = stream.names().filter(name => name === "change").length;
    await f.clock.advance(milliseconds);
    assert.equal(stream.names().filter(name => name === "change").length, changes + 1);
  }
  await f.clock.advance(10000);
  assert.equal(stream.names().filter(name => name === "change").length, 5);
  assert.equal(f.reads.orders, initialReads, "Time transitions must not read the orders table again");
  assert.ok(stream.names().includes("heartbeat"));
});

test("idle accounts share one loaded schedule while heartbeat and session validation stay bounded", async t => {
  const f = await fixture(t), one = await f.connect(f.a), two = await f.connect(f.a);
  assert.equal(f.reads.orders, 1);
  const authReads = f.reads.auth;
  await f.clock.advance(120000);
  assert.equal(f.reads.orders, 1);
  assert.equal(f.reads.auth - authReads, 4, "Each active session is checked once per minute");
  assert.equal(one.names().filter(name => name === "heartbeat").length, 4);
  assert.equal(two.names().filter(name => name === "heartbeat").length, 4);
  assert.equal(one.names().filter(name => name === "change").length, 0);
});

test("revoked and expired sessions emit session-expired and release their timers", async t => {
  const f = await fixture(t);
  const revoked = await f.connect(f.a);
  await f.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(f.a.id).run();
  await f.clock.advance(60000);
  assert.equal(revoked.names().at(-1), "session-expired");
  assert.equal(revoked.closed(), true);
  assert.equal(f.clock.size(), 0);

  await f.DB.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").bind(f.clock.now() - SESSION_AGE + 1000, f.b.id).run();
  const expired = await f.connect(f.b);
  await f.clock.advance(1000);
  assert.deepEqual(expired.names(), ["ready", "session-expired"]);
  assert.equal(expired.closed(), true);
  assert.equal(f.clock.size(), 0);
});

test("disconnect, cancellation and normal rotation clear subscriptions and boundary timers", async t => {
  const f = await fixture(t), abort = new AbortController();
  const disconnected = await f.connect(f.a, { signal: abort.signal });
  abort.abort(); await flush();
  assert.equal(disconnected.closed(), true);
  assert.equal(f.clock.size(), 0);
  const cancelled = await f.connect(f.a);
  await cancelled.stop();
  assert.equal(f.clock.size(), 0);
  const rotating = await f.connect(f.a);
  await f.clock.advance(240000);
  assert.equal(rotating.closed(), true);
  assert.ok(!rotating.names().includes("session-expired"));
  assert.equal(f.clock.size(), 0);
});

test("per-account/global caps and bounded slow-reader queues release slots for recovery", async t => {
  const f = await fixture(t, { maxPerAccount: 2, maxConnections: 3, bufferBytes: 80 });
  const first = await f.connect(f.a), second = await f.connect(f.a);
  assert.equal((await f.call(f.a, "/api/events")).status, 429);
  const third = await f.connect(f.b);
  const capped = await f.call(f.b, "/api/events");
  assert.equal(capped.status, 429);
  assert.equal(capped.headers.get("retry-after"), "30");
  await first.stop(); await second.stop(); await third.stop();
  const slow = await f.call(f.a, "/api/events"); // Intentionally leave this body unread.
  for (let count = 0; count < 6; count++) await f.hub.publish(f.a.account_id);
  await flush();
  assert.equal(f.clock.size(), 0);
  assert.ok((await slow.text()).length <= 80);
  const recovered = await f.connect(f.a);
  assert.deepEqual(recovered.names(), ["ready"]);
});

test("boundary collection is deduplicated, ignores expired times and retains legacy timing", () => {
  const created = 1000;
  const row = { id: "old", items: "[]", subtotal: 0, total: 0, location: "Library entrance", created_at: created, delivery_route: null };
  assert.deepEqual(orderBoundaries([row, row], created), [21000, 52000]);
  assert.deepEqual(orderBoundaries([row], 66000), []);
});
