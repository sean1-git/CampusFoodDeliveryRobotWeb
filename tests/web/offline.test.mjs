import test from "node:test";
import assert from "node:assert/strict";
import catalog from "../../packages/domain/src/catalog/catalog.json" with { type: "json" };
import { readInventorySnapshot, inventoryNeedsRefresh, INVENTORY_REFRESH_MS,
  readReservation, reservationExpired } from "../../apps/web/src/shared/state/inventoryCache.ts";

test("offline reload restores actual saved stock and its successful refresh timestamp", () => {
  const snapshot = { catalog: { ...catalog, responseGeneratedAt: 1000,
    products: catalog.products.map((p) => ({ ...p, stock: p.id === "sandwich" ? 1 : 20,
      stockUpdatedAt: 500, syncedAt: 750 })) }, fetchedAt: 1100 };
  const disk = JSON.stringify(snapshot);
  assert.deepEqual(readInventorySnapshot({ getItem: () => disk }), snapshot);
  // Reading stale data offline must never change its timestamp to the current time.
  assert.equal(readInventorySnapshot({ getItem: () => disk }).fetchedAt, 1100);
});
test("inventory refresh is due at exactly fifteen minutes, including on reconnect", () => {
  assert.equal(inventoryNeedsRefresh(1000, 1000 + INVENTORY_REFRESH_MS - 1), false);
  assert.equal(inventoryNeedsRefresh(1000, 1000 + INVENTORY_REFRESH_MS), true);
  assert.equal(inventoryNeedsRefresh(null, 1000), true);
  assert.equal(inventoryNeedsRefresh(2000, 1000), true);
});

test("older cached catalogs gain store assignments without refreshing their stock timestamps", () => {
  const snapshot = { catalog: { ...catalog, products: catalog.products.map(({ storeId: _storeId, ...p }) => ({ ...p, stock: 3 })) }, fetchedAt: 1100 };
  const restored = readInventorySnapshot({ getItem: () => JSON.stringify(snapshot) });
  assert.equal(restored.catalog.products.find(p => p.id === "sandwich").storeId, "library");
  assert.equal(restored.catalog.products.find(p => p.id === "noodles").storeId, "summits");
  assert.equal(restored.catalog.products[0].stock, 3);
  assert.equal(restored.fetchedAt, 1100);
});
test("missing, corrupt, or inaccessible offline snapshots safely fall back", () => {
  for (const text of [null, "{", "{}", JSON.stringify({ fetchedAt: 10, catalog: {} })]) {
    assert.equal(readInventorySnapshot({ getItem: () => text }), null);
  }
  assert.equal(readInventorySnapshot({ getItem() { throw new Error("disabled"); } }), null);
});
test("reservation reload keeps its original deadline; offline expiry includes server clock offset", () => {
  const hold = { key: crypto.randomUUID(), body: { items: [{ id: "sandwich", quantity: 1 }], location: "Library entrance" },
    expiresAt: 301000, clockOffsetMs: 1000, phase: "held" };
  const restored = readReservation({ getItem: () => JSON.stringify(hold) });
  assert.equal(restored.expiresAt, hold.expiresAt);
  assert.equal(reservationExpired(restored, 299999), false);
  assert.equal(reservationExpired(restored, 300000), true);
  assert.equal(reservationExpired({ ...restored, phase: "cancelling" }, 300000), true);
  assert.equal(reservationExpired({ ...restored, phase: "confirming" }, 300000), false);
});
