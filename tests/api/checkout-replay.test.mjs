import test from "node:test";
import assert from "node:assert/strict";
import catalog from "../../packages/domain/src/catalog/catalog.json" with { type: "json" };
import { handleApi } from "../../apps/api/src/api.mjs";
import { openDatabase } from "../../apps/api/src/database/local-db.mjs";
import { studentSession } from "../fixtures/student-fixture.mjs";

const basket = { items: [{ id: "sandwich", quantity: 1 }],
  destination: { lat: 37.365562, lng: -120.424938, confirmed: true } };

async function fixture(t) {
  const db = openDatabase(); t.after(() => db.close());
  const user = await studentSession(db), key = crypto.randomUUID();
  async function call(path, body, requestKey = key) {
    const response = await handleApi(new Request(`https://campus.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: user.cookie, origin: "https://campus.test", "content-type": "application/json",
        "x-csrf-token": user.csrf, "idempotency-key": requestKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { DB: db });
    return { status: response.status, body: await response.json() };
  }
  return { db, user, key, call };
}

function changeCatalog(t) {
  const product = catalog.products.find(item => item.id === "sandwich");
  const before = { name: product.name, priceCents: product.priceCents }, fee = catalog.deliveryFeeCents;
  t.after(() => { Object.assign(product, before); catalog.deliveryFeeCents = fee; });
  product.name = "Renamed sandwich"; product.priceCents += 100; catalog.deliveryFeeCents += 100;
}

test("completed checkout retries and receipts preserve prices across catalog edits", async t => {
  const f = await fixture(t);
  const order = await f.call("/api/orders", basket);
  assert.equal(order.status, 201);
  changeCatalog(t);
  const replay = await f.call("/api/orders", { ...basket, items: [{ ...basket.items[0], priceCents: 1, name: "forged" }] });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, order.body.id);
  assert.deepEqual(replay.body.items, order.body.items);
  const receipt = await f.call(`/api/orders/${order.body.id}`);
  assert.equal(receipt.body.deliveryFeeCents, order.body.deliveryFeeCents);
  assert.equal(receipt.body.totalCents, receipt.body.subtotalCents + receipt.body.deliveryFeeCents);
  assert.equal((await f.call("/api/session")).body.balanceCents, 5000 - order.body.totalCents);
});

test("legacy held fingerprints survive catalog edits and concurrent confirmations", async t => {
  const f = await fixture(t), held = await f.call("/api/reservations", basket);
  assert.equal(held.body.status, "held");
  const row = await f.db.prepare("SELECT * FROM checkout_queue WHERE request_key = ?").bind(f.key).first();
  const legacyHash = JSON.stringify({ items: JSON.parse(row.items), destination: basket.destination });
  await f.db.prepare("UPDATE checkout_queue SET request_hash = ? WHERE request_key = ?").bind(legacyHash, f.key).run();
  changeCatalog(t);
  const replay = await f.call("/api/reservations", basket);
  assert.equal(replay.body.status, "held");
  assert.equal(replay.body.expiresAt, held.body.expiresAt);
  for (const body of [
    { ...basket, items: [{ id: "sandwich", quantity: 2 }] },
    { ...basket, destination: { ...basket.destination, lat: 37.363311 } },
  ]) assert.equal((await f.call("/api/reservations", body)).status, 409);
  const orders = await Promise.all(Array.from({ length: 5 }, () => f.call(`/api/reservations/${f.key}/confirm`, {})));
  assert.ok(orders.every(order => order.status === 201));
  assert.equal(new Set(orders.map(order => order.body.id)).size, 1);
  assert.deepEqual(orders[0].body.items, JSON.parse(row.items));
  assert.equal(orders[0].body.totalCents, row.total);
  assert.equal(orders[0].body.deliveryFeeCents, row.total - row.subtotal);
  assert.equal((await f.call("/api/orders", basket)).status, 200);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM orders").first()).count, 1);
});

test("saved legacy products removed from today's catalog remain replayable only with their original key", async t => {
  const f = await fixture(t), order = await f.call("/api/orders", basket);
  assert.equal(order.status, 201);
  // Model a persisted order from a release that sold this now-retired product.
  const items = order.body.items.map(item => ({ ...item, id: "retired-sandwich" }));
  const legacyHash = JSON.stringify({ items, destination: basket.destination });
  await f.db.batch([
    f.db.prepare("INSERT INTO inventory (product_id, quantity) VALUES ('retired-sandwich', 20)"),
    f.db.prepare("UPDATE order_items SET product_id = 'retired-sandwich' WHERE order_id = ?").bind(order.body.id),
    f.db.prepare("UPDATE orders SET items = ?, request_hash = ? WHERE id = ?").bind(JSON.stringify(items), legacyHash, order.body.id),
    f.db.prepare("UPDATE checkout_queue SET items = ?, request_hash = ? WHERE request_key = ?").bind(JSON.stringify(items), legacyHash, f.key),
  ]);
  const retiredBasket = { ...basket, items: [{ id: "retired-sandwich", quantity: 1 }] };
  const replay = await f.call("/api/orders", retiredBasket);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, order.body.id);
  assert.deepEqual(replay.body.items, items);
  assert.equal((await f.call("/api/orders", retiredBasket, crypto.randomUUID())).status, 400);
  assert.equal((await f.call("/api/orders", { ...retiredBasket, items: [{ id: "retired-sandwich", quantity: 2 }] })).status, 409);
});

test("reordered intent replays safely while malformed carts still fail before lookup", async t => {
  const f = await fixture(t), mixed = { ...basket, items: [...basket.items, { id: "coffee", quantity: 1 }] };
  const order = await f.call("/api/orders", mixed);
  assert.equal(order.status, 201);
  const replay = await f.call("/api/orders", { ...mixed, items: [...mixed.items].reverse() });
  assert.equal(replay.body.id, order.body.id);
  for (const items of [[], [null], [{ id: "sandwich", quantity: 0 }], [{ id: "sandwich", quantity: 21 }],
    [{ id: "sandwich", quantity: 1.5 }], [basket.items[0], basket.items[0]]])
    assert.equal((await f.call("/api/orders", { ...basket, items })).status, 400);
  assert.equal((await f.call("/api/orders", { ...basket, destination: { ...basket.destination, confirmed: false } })).status, 400);
});
