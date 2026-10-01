import test from "node:test";
import assert from "node:assert/strict";
import { createReadGate, retryAfterMs, checkoutRetryDelay } from "../../apps/web/src/shared/api/readGate.ts";
import { persistValue, MAX_INVENTORY_BYTES } from "../../apps/web/src/shared/state/persistValue.ts";

test("concurrent reads share transport, but completed responses are not cached", async () => {
  const read = createReadGate();
  let calls = 0, finish;
  const run = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const a = read("session", run), b = read("session", run);
  await Promise.resolve();
  assert.equal(calls, 1); assert.equal(a, b);
  finish({ wallet: 100 }); await a;
  const c = read("session", run); await Promise.resolve();
  assert.equal(calls, 2); finish({ wallet: 50 }); assert.deepEqual(await c, { wallet: 50 });
});

test("outage retries back off, respect Retry-After, and reset after recovery", async () => {
  let now = 0, calls = 0;
  const read = createReadGate(() => now, () => 1);
  const fail = () => { calls++; return Promise.reject(Object.assign(new Error("busy"), { status: 503, retryAfterMs: 10000 })); };
  await assert.rejects(read("catalog", fail));
  now = 9999; await assert.rejects(read("catalog", fail)); assert.equal(calls, 1);
  now = 10000; await assert.rejects(read("catalog", fail)); assert.equal(calls, 2);
  now = 20000; assert.equal(await read("catalog", async () => "fresh"), "fresh");
  await assert.rejects(read("catalog", fail)); assert.equal(calls, 3);
});

test("authentication errors do not suppress a new login's read", async () => {
  const read = createReadGate();
  await assert.rejects(read("session", async () => { throw Object.assign(new Error("login"), { status: 401 }); }));
  assert.equal(await read("session", async () => "new account"), "new account");
});

test("retry header accepts seconds and HTTP dates and bounds invalid values", () => {
  assert.equal(retryAfterMs("20", 0), 20000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:01:00 GMT", 0), 60000);
  assert.equal(retryAfterMs("bad"), 0);
  assert.equal(retryAfterMs("-1"), 0);
  assert.equal(retryAfterMs("999999"), 3600000);
});

test("queued checkout retries use a bounded progressive delay instead of a 100ms loop", () => {
  assert.deepEqual([0,1,2,3,4,20].map(checkoutRetryDelay), [500,1000,2000,4000,4000,4000]);
});

test("oversized inventory is not persisted", () => {
  const removed = [], writes = [];
  const storage = { setItem: (...args) => writes.push(args), removeItem: key => removed.push(key) };
  assert.equal(persistValue(storage, "campus-inventory-v1", "x".repeat(MAX_INVENTORY_BYTES)), false);
  assert.equal(writes.length, 0); assert.deepEqual(removed, ["campus-inventory-v1"]);
});

test("storage pressure evicts only disposable inventory before retrying the checkout ID", () => {
  const removed = [], writes = [];
  const storage = { setItem(key, value) { writes.push([key,value]); if(writes.length === 1) throw new Error("quota"); }, removeItem: key => removed.push(key) };
  assert.equal(persistValue(storage, "campus-checkout-hold", { key: "keep-me" }), true);
  assert.deepEqual(removed, ["campus-inventory-v1"]);
  assert.deepEqual(writes[1], ["campus-checkout-hold", '{"key":"keep-me"}']);
});

test("denied storage is nonfatal", () => {
  const storage = { setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  assert.equal(persistValue(storage, "campus-cart", {}), false);
});
