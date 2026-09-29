import test from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../../apps/api/src/api.mjs";
import { openDatabase } from "../../apps/api/src/database/local-db.mjs";
import { createRateLimiter, rateLimiterFor, RATE_LIMITS } from "../../apps/api/src/http/rate-limit.mjs";

const origin = "https://campus.test";
const basket = { items: [{ id: "sandwich", quantity: 1 }],
  destination: { lat: 37.365562, lng: -120.424938, confirmed: true } };

function setup(t) {
  const DB = openDatabase();
  t.after(() => DB.close());
  let clock = 0;
  rateLimiterFor(DB, { clock: () => clock });
  const call = (path, { user, method = "GET", body, key = crypto.randomUUID(), headers = {} } = {}) =>
    handleApi(new Request(origin + path, { method,
      headers: { origin, "content-type": "application/json", "idempotency-key": key,
        ...(user ? { cookie: user.cookie, "x-csrf-token": user.csrf } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { DB });
  const visitor = async () => {
    const response = await call("/api/session");
    assert.equal(response.status, 200);
    return { ...(await response.json()), cookie: response.headers.get("set-cookie").split(";")[0] };
  };
  const count = async table => (await DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n;
  return { DB, call, visitor, count, advance: ms => { clock += ms; } };
}

test("anonymous bootstrap floods are bounded before allocating accounts; authenticated reads still work", async t => {
  const f = setup(t), visitor = await f.visitor();
  const replies = await Promise.all(Array.from({ length: 100 }, () => f.call("/api/session")));
  assert.equal(replies.filter(response => response.status === 200).length, RATE_LIMITS.session.burst - 1);
  const rejected = replies.find(response => response.status === 429);
  assert.equal(rejected.headers.get("retry-after"), "1");
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.equal(rejected.headers.has("set-cookie"), false);
  assert.equal((await rejected.json()).code, "rate_limited");
  assert.equal(await f.count("accounts"), RATE_LIMITS.session.burst);
  assert.equal(await f.count("sessions"), RATE_LIMITS.session.burst);
  assert.equal((await f.call("/api/session?include=orders", { user: visitor })).status, 200);
  assert.equal((await f.call("/api/catalog")).status, 200);
  f.advance(RATE_LIMITS.session.refillMs);
  assert.equal((await f.call("/api/session")).status, 200);
  assert.equal((await f.call("/api/session")).status, 429);
  assert.equal((await setup(t).call("/api/session")).status, 200, "Database bindings do not share allowances");
});

test("new checkout limits preserve held retries, confirmation, cancellation, and account isolation", async t => {
  const f = setup(t), a = await f.visitor(), b = await f.visitor(), key = crypto.randomUUID();
  const reserve = (user, requestKey = crypto.randomUUID(), body = basket) =>
    f.call("/api/reservations", { user, method: "POST", body, key: requestKey });
  assert.equal((await (await reserve(a, key)).json()).status, "held");
  // Even invalid new attempts cost allowance, but never allocate queue rows.
  for (let i = 1; i < RATE_LIMITS.checkout.burst; i++)
    assert.equal((await reserve(a, crypto.randomUUID(), { items: [] })).status, 400);
  const rejected = await reserve(a);
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get("retry-after"), "3");
  assert.equal(await f.count("checkout_queue"), 1);
  assert.equal((await (await reserve(a, key)).json()).status, "held", "Identical retry remains available");
  assert.equal((await f.call(`/api/checkouts/${key}`, { user: a })).status, 200);
  assert.equal((await f.call(`/api/checkouts/${key}`, { user: b })).status, 404);
  assert.equal((await reserve(a, key, { ...basket, items: [{ id: "sandwich", quantity: 2 }] })).status, 409,
    "Retry exemption must not bypass the request fingerprint");
  const otherKey = crypto.randomUUID();
  assert.equal((await (await reserve(b, otherKey)).json()).status, "held", "Other accounts retain their allowance");
  for (let i = 1; i < RATE_LIMITS.checkout.burst; i++)
    await reserve(b, crypto.randomUUID(), { items: [] });
  const cancel = await f.call(`/api/reservations/${otherKey}/cancel`, { user: b, method: "POST" });
  assert.equal((await cancel.json()).status, "cancelled", "A spent creation budget cannot strand a hold");
  const confirm = () => f.call(`/api/reservations/${key}/confirm`, { user: a, method: "POST" });
  const purchase = await confirm();
  assert.equal(purchase.status, 201);
  const order = await purchase.json();
  assert.equal((await (await confirm()).json()).id, order.id);
  assert.equal((await (await reserve(a, key)).json()).id, order.id);
  assert.equal(await f.count("orders"), 1);
  assert.equal((await (await f.call("/api/session", { user: a })).json()).balanceCents, 4250);
});

test("direct purchases share the new-checkout budget without blocking accepted-order retries", async t => {
  const f = setup(t), user = await f.visitor(), key = crypto.randomUUID();
  const purchase = (requestKey, body = basket) => f.call("/api/orders", { user, method: "POST", key: requestKey, body });
  const first = await purchase(key);
  assert.equal(first.status, 201);
  const order = await first.json();
  for (let i = 1; i < RATE_LIMITS.checkout.burst; i++)
    assert.equal((await purchase(crypto.randomUUID(), { items: [] })).status, 400);
  assert.equal((await purchase(crypto.randomUUID())).status, 429);
  assert.equal((await (await purchase(key)).json()).id, order.id);
  assert.equal(await f.count("orders"), 1);
  assert.equal((await f.call("/api/orders", { user })).status, 200);
});

test("simultaneous retries use one creation allowance even before their queue insert is visible", async t => {
  const f = setup(t), user = await f.visitor(), key = crypto.randomUUID();
  for (let i = 1; i < RATE_LIMITS.checkout.burst; i++)
    await f.call("/api/reservations", { user, method: "POST", body: { items: [] } });
  const results = await Promise.all(Array.from({ length: 25 }, () =>
    f.call("/api/reservations", { user, method: "POST", body: basket, key })));
  assert.ok(results.every(response => response.status === 200));
  assert.ok((await Promise.all(results.map(response => response.json()))).every(body => body.status === "held"));
  assert.equal(await f.count("checkout_queue"), 1);
  assert.equal((await f.call("/api/reservations", { user, method: "POST", body: basket })).status, 429);
});

test("origin and CSRF failures neither consume another account's budget nor bypass validation", async t => {
  const f = setup(t), user = await f.visitor();
  for (let i = 0; i <= RATE_LIMITS.checkout.burst; i++) {
    assert.equal((await f.call("/api/reservations", { user, method: "POST", body: basket,
      headers: { "x-csrf-token": "invalid" } })).status, 403);
    assert.equal((await f.call("/api/session", { headers: { origin: "https://attacker.test" } })).status, 403);
  }
  assert.equal(await f.count("accounts"), 1);
  assert.equal((await f.call("/api/reservations", { user, method: "POST", body: basket })).status, 200);
  assert.equal(await f.count("checkout_queue"), 1);
});

test("monotonic rate accounting cannot refill early after clock rollback or accumulate beyond burst", () => {
  let clock = 10000;
  const limiter = createRateLimiter({ clock: () => clock });
  for (let i = 0; i < RATE_LIMITS.session.burst; i++) assert.equal(limiter.session(), 0);
  assert.equal(limiter.session(), 1);
  clock = 9000; assert.equal(limiter.session(), 1);
  clock = 10000; assert.equal(limiter.session(), 1);
  clock = 11000; assert.equal(limiter.session(), 0);
  assert.equal(limiter.session(), 1);
  clock += 86400000;
  for (let i = 0; i < RATE_LIMITS.session.burst; i++) assert.equal(limiter.session(), 0);
  assert.equal(limiter.session(), 1);
});

test("bounded account capacity fails closed rather than evicting active limits, and reclaims idle buckets", () => {
  let clock = 0;
  const limiter = createRateLimiter({ clock: () => clock, maxAccounts: 2 });
  for (let i = 0; i < RATE_LIMITS.checkout.burst; i++) assert.equal(limiter.checkout("a"), 0);
  assert.equal(limiter.checkout("b"), 0);
  for (let i = 0; i < 100; i++) assert.equal(limiter.checkout(`new-${i}`), 3);
  assert.equal(limiter.checkout("a"), 3, "Account rotation cannot reset exhausted allowances");
  clock = 3000;
  assert.equal(limiter.checkout("c"), 0, "Fully replenished idle account b can be reclaimed");
  assert.equal(limiter.checkout("a"), 0);
  assert.equal(limiter.checkout("a"), 3);
});
