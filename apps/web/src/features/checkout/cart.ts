import type { Cart, Product } from "../../shared/types";

// Restored carts contain zero entries, while held checkouts contain only selected
// items. Treat those shapes alike so hydration does not invalidate memoized views.
export function sameCartQuantities(a: Cart, b: Cart): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ids].every(id => (a[id] ?? 0) === (b[id] ?? 0));
}

export function summarizeCart(products: Product[], cart: Cart, deliveryFeeCents: number) {
  const lines = products.filter(product => cart[product.id] > 0);
  const quantity = lines.reduce((sum, product) => sum + cart[product.id], 0);
  const subtotal = lines.reduce((sum, product) => sum + product.priceCents * cart[product.id], 0);
  return { lines, quantity, subtotal, total: subtotal + (quantity ? deliveryFeeCents : 0) };
}
