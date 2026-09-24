import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/local-db.mjs";
import { handleApi } from "../server/api.mjs";
import { ensureInventory, inventoryFreshnessStatement } from "../server/inventory.mjs";
import { inventoryFreshnessLabel } from "../src/lib/inventoryFreshness.ts";
import { readInventorySnapshot } from "../src/lib/inventoryCache.ts";
import catalog from "../shared/catalog.json" with { type: "json" };

async function fixture(t) {
  const DB = openDatabase();
  t.after(() => DB.close());
  await ensureInventory(DB);
  return DB;
}
async function readCatalog(DB, now) {
  const response = await handleApi(new Request("https://campus.test/api/catalog"), { DB }, now);
  assert.equal(response.status, 200);
  return response.json();
}
const sandwich = (menu) => menu.products.find((product) => product.id === "sandwich");

test("seeded demo inventory has unknown source timestamps; catalog reads do not advance them", async (t) => {
  const DB = await fixture(t);
  for (const now of [10000, 20000]) {
    const menu = await readCatalog(DB, now);
    assert.equal(menu.responseGeneratedAt, now);
    assert.equal(menu.inventoryUpdatedAt, undefined);
    assert.ok(menu.products.every((product) => product.stockUpdatedAt === null && product.syncedAt === null));
  }
});

test("API preserves per-item source timestamps separately from receipt and response times", async (t) => {
  const DB = await fixture(t);
  await DB.batch([
    inventoryFreshnessStatement(DB, "sandwich", 1000, 2000),
    inventoryFreshnessStatement(DB, "coffee", null, 2500),
  ]);
  for (const now of [3000, 4000]) {
    const menu = await readCatalog(DB, now);
    assert.equal(sandwich(menu).stockUpdatedAt, 1000);
    assert.equal(sandwich(menu).syncedAt, 2000);
    assert.equal(menu.products.find((p) => p.id === "coffee").stockUpdatedAt, null);
    assert.equal(menu.products.find((p) => p.id === "coffee").syncedAt, 2500);
    assert.equal(menu.responseGeneratedAt, now);
  }
  // An unchanged upstream snapshot can advance receipt time, not change time.
  await DB.batch([inventoryFreshnessStatement(DB, "sandwich", 1000, 5000)]);
  const refreshed = sandwich(await readCatalog(DB, 6000));
  assert.equal(refreshed.stockUpdatedAt, 1000);
  assert.equal(refreshed.syncedAt, 5000);
});

test("missing upstream change time falls back to sync and is never inferred from quantity changes", async (t) => {
  const DB = await fixture(t);
  await DB.batch([inventoryFreshnessStatement(DB, "sandwich", 1000, 2000)]);
  await DB.batch([
    DB.prepare("UPDATE inventory SET quantity = 10 WHERE product_id = 'sandwich'"),
    inventoryFreshnessStatement(DB, "sandwich", undefined, 3000),
  ]);
  const product = sandwich(await readCatalog(DB, 4000));
  assert.equal(product.stock, 10);
  assert.equal(product.stockUpdatedAt, null);
  assert.equal(product.syncedAt, 3000);
  assert.match(inventoryFreshnessLabel(product), /Last synced with inventory source:/);
  assert.match(inventoryFreshnessLabel(product), /Source stock-change time unavailable/);
  assert.doesNotMatch(inventoryFreshnessLabel(product), /Source-reported stock change:/);
});

test("failed sync transaction rolls back freshness metadata with inventory", async (t) => {
  const DB = await fixture(t);
  await DB.batch([inventoryFreshnessStatement(DB, "sandwich", 1000, 2000)]);
  await assert.rejects(DB.batch([
    inventoryFreshnessStatement(DB, "sandwich", 3000, 4000),
    DB.prepare("UPDATE inventory SET quantity = -1 WHERE product_id = 'sandwich'"),
  ]));
  const product = sandwich(await readCatalog(DB, 5000));
  assert.equal(product.stock, 20);
  assert.equal(product.stockUpdatedAt, 1000);
  assert.equal(product.syncedAt, 2000);
});

test("metadata validation and an older receipt cannot overwrite a newer sync", async (t) => {
  const DB = await fixture(t);
  for (const value of [-1, NaN, Infinity, "2026-09-23", 0.5, 8640000000000001]) {
    assert.throws(() => inventoryFreshnessStatement(DB, "sandwich", value, 5000));
    assert.throws(() => inventoryFreshnessStatement(DB, "sandwich", null, value));
  }
  assert.throws(() => inventoryFreshnessStatement(DB, "not-a-product", null, 5000));
  await DB.batch([inventoryFreshnessStatement(DB, "sandwich", 1000, 5000)]);
  await DB.batch([inventoryFreshnessStatement(DB, "sandwich", null, 4000)]);
  assert.equal(sandwich(await readCatalog(DB, 6000)).syncedAt, 5000);
  assert.equal(sandwich(await readCatalog(DB, 6000)).stockUpdatedAt, 1000);
});

test("legacy offline cache retains stock but never relabels response/fetch time as source freshness", () => {
  const legacy = { catalog: { ...catalog, inventoryUpdatedAt: 2000,
    products: catalog.products.map((p) => ({ ...p, stock: 7 })) }, fetchedAt: 3000 };
  const restored = readInventorySnapshot({ getItem: () => JSON.stringify(legacy) });
  assert.equal(restored.fetchedAt, 3000);
  assert.equal(restored.catalog.inventoryUpdatedAt, undefined);
  assert.equal(restored.catalog.responseGeneratedAt, null);
  assert.equal(sandwich(restored.catalog).stock, 7);
  assert.equal(sandwich(restored.catalog).stockUpdatedAt, null);
  assert.equal(sandwich(restored.catalog).syncedAt, null);
  assert.match(inventoryFreshnessLabel(sandwich(restored.catalog)), /Not yet synced/);
});

test("offline cache preserves independent source/sync clocks and sanitizes invalid metadata", () => {
  const data = { catalog: { ...catalog, responseGeneratedAt: 4000,
    products: catalog.products.map((p) => ({ ...p, stock: 7, stockUpdatedAt: 1000, syncedAt: 2000 })) }, fetchedAt: 5000 };
  const read = () => readInventorySnapshot({ getItem: () => JSON.stringify(data) });
  assert.deepEqual(read(), data);
  assert.match(inventoryFreshnessLabel(sandwich(read().catalog)), /Source-reported stock change:/);
  sandwich(data.catalog).stockUpdatedAt = -1;
  sandwich(data.catalog).syncedAt = "not a date";
  assert.equal(sandwich(read().catalog).stockUpdatedAt, null);
  assert.equal(sandwich(read().catalog).syncedAt, null);
  assert.equal(read().fetchedAt, 5000);
});
