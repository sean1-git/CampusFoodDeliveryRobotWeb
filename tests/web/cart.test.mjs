import test from "node:test";
import assert from "node:assert/strict";
import catalog from "../../packages/domain/src/catalog/catalog.json" with { type: "json" };
import { sameCartQuantities, summarizeCart } from "../../apps/web/src/features/checkout/cart.ts";

test("restored zero entries and held-checkout carts compare by selected quantities", () => {
  const restored = Object.freeze({ sandwich: 2, coffee: 0, noodles: 1 });
  const held = Object.freeze({ noodles: 1, sandwich: 2 });
  assert.equal(sameCartQuantities(restored, held), true);
  assert.equal(sameCartQuantities({}, { sandwich: 0 }), true);
  assert.equal(sameCartQuantities(restored, { sandwich: 1, noodles: 1 }), false);
  assert.equal(sameCartQuantities(restored, { sandwich: 2 }), false);
  assert.equal(sameCartQuantities(restored, { ...held, cookie: 1 }), false);
});

test("a mixed-store bag includes all selected items and charges one delivery fee", () => {
  const cart = Object.freeze({ sandwich: 2, noodles: 1, coffee: 0 });
  const summary = summarizeCart(catalog.products, cart, catalog.deliveryFeeCents);
  assert.deepEqual(summary.lines.map(product => product.id), ["sandwich", "noodles"]);
  assert.equal(summary.quantity, 3);
  assert.equal(summary.subtotal, 2050);
  assert.equal(summary.total, 2150);
  assert.equal(summary.lines[0], catalog.products[0], "Preserve current product metadata for the bag and route preview");
});

test("an empty bag or a removed catalog item never creates a delivery fee", () => {
  for (const cart of [{}, { sandwich: 0 }, { discontinued: 2 }]) {
    assert.deepEqual(summarizeCart(catalog.products, cart, 100), { lines: [], quantity: 0, subtotal: 0, total: 0 });
  }
});

test("refreshed catalog prices update estimates without silently discarding out-of-stock selections", () => {
  const products = catalog.products.map(product => product.id === "sandwich" ? { ...product, priceCents: 700, stock: 0 } : product);
  const summary = summarizeCart(products, { sandwich: 2 }, 125);
  assert.equal(summary.quantity, 2);
  assert.equal(summary.subtotal, 1400);
  assert.equal(summary.total, 1525);
  assert.equal(summary.lines[0].stock, 0);
});
