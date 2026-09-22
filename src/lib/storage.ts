/**
 * Reads and writes browser localStorage for the bag and pending checkout.
 * Falls back when storage is unavailable and limits restored cart quantities.
 */
import sampleCatalog from "../../shared/catalog.json";
import type { Cart } from "../types";

export function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* The app still works without browser storage. */
  }
}
export function initialCart(): Cart {
  const stored = load<unknown>("campus-cart", {});
  if (!stored || typeof stored !== "object") return {};
  return Object.fromEntries(
    sampleCatalog.products.map((p) => [
      p.id,
      Math.min(
        20,
        Math.max(0, Math.floor(Number((stored as Cart)[p.id]) || 0)),
      ),
    ]),
  );
}
