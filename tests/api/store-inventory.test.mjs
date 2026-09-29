import test from "node:test";
import assert from "node:assert/strict";
import catalog from "../../packages/domain/src/catalog/catalog.json" with { type: "json" };
import { stores } from "../../packages/domain/src/catalog/stores.ts";
import { openDatabase } from "../../apps/api/src/database/local-db.mjs";
import { handleApi } from "../../apps/api/src/api.mjs";
import { studentSession } from "../fixtures/student-fixture.mjs";

test("each store has six distinct simulated products with stable pickup ownership", () => {
  assert.deepEqual(stores.map(s => s.name), ["The Summit's Marketplace", "Bobcat's Snack shop"]);
  assert.equal(catalog.inventorySource, "simulated");
  assert.equal(new Set(catalog.products.map(p => p.id)).size, 12);
  for (const store of stores) {
    const items = catalog.products.filter(p => p.storeId === store.id);
    assert.equal(items.length, 6);
    assert.deepEqual(new Set(items.map(p => p.category)), new Set(["Lunch", "Drinks", "Snacks"]));
  }
});

test("new demo products have shared stock and a seven-item mixed-store bag can check out", async t => {
  const DB = openDatabase(); t.after(() => DB.close()); const user = await studentSession(DB);
  const call = (path, body, key = crypto.randomUUID()) => handleApi(new Request(`https://campus.test${path}`, {
    method: body ? "POST" : "GET", headers: { origin: "https://campus.test", cookie: user.cookie, "content-type": "application/json", "x-csrf-token": user.csrf, "idempotency-key": key },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { DB });
  const before = await (await call("/api/catalog")).json();
  assert.equal(before.products.length, 12);
  assert.ok(before.products.every(p => p.stock === 20));
  const selected = [...catalog.products].sort((a, b) => a.priceCents - b.priceCents).slice(0, 7);
  const key = crypto.randomUUID();
  let response = await call("/api/orders", { items: selected.map(p => ({ id: p.id, quantity: 1, storeId: "forged" })),
    destination: { lat: 37.363311, lng: -120.427830, confirmed: true } }, key);
  for (let i = 0; response.status === 202 && i < 10; i++) { await new Promise(r => setTimeout(r, 100)); response = await call(`/api/checkouts/${key}`); }
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.equal(order.items.length, 7);
  assert.deepEqual(new Set(order.deliveryRoute.pickups.map(p => p.name)), new Set(stores.map(s => s.name)));
  const after = await (await call("/api/catalog")).json();
  for (const p of after.products) assert.equal(p.stock, selected.some(item => item.id === p.id) ? 19 : 20);
});
