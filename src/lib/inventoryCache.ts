import type { Catalog, Reservation } from "../types";
import { inventoryTimestamp } from "./inventoryFreshness.ts";

export const INVENTORY_REFRESH_MS = 15 * 60 * 1000;
export const INVENTORY_CACHE_KEY = "campus-inventory-v1";
export const RESERVATION_KEY = "campus-checkout-hold";
export type InventorySnapshot = { catalog: Catalog; fetchedAt: number };

type Reader = Pick<Storage, "getItem">;
export function readInventorySnapshot(storage: Reader): InventorySnapshot | null {
  try {
    const value = JSON.parse(storage.getItem(INVENTORY_CACHE_KEY) || "null");
    if (!value || !Number.isFinite(value.fetchedAt) || value.fetchedAt <= 0) return null;
    const menu = value.catalog;
    if (!menu || !Number.isFinite(menu.deliveryFeeCents) || !Number.isFinite(menu.initialBalanceCents)
      || !Array.isArray(menu.locations) || !menu.locations.every((x: unknown) => typeof x === "string")
      || !Array.isArray(menu.products) || !menu.products.length) return null;
    if (!menu.products.every((p: Record<string, unknown>) => p
      && ["id", "name", "description", "category", "emoji", "color", "tag"].every((k) => typeof p[k] === "string")
      && Number.isInteger(p.priceCents) && Number.isInteger(p.stock) && (p.stock as number) >= 0)) return null;
    // v1 caches used response generation as inventoryUpdatedAt. Preserve stock,
    // but never promote that timestamp (or fetchedAt) to source freshness.
    delete menu.inventoryUpdatedAt;
    menu.responseGeneratedAt = inventoryTimestamp(menu.responseGeneratedAt);
    menu.products = menu.products.map((p: Record<string, unknown>) => ({ ...p,
      stockUpdatedAt: inventoryTimestamp(p.stockUpdatedAt), syncedAt: inventoryTimestamp(p.syncedAt),
    }));
    return value;
  } catch { return null; }
}

export function inventoryNeedsRefresh(fetchedAt: number | null, now: number): boolean {
  return !fetchedAt || now < fetchedAt || now - fetchedAt >= INVENTORY_REFRESH_MS;
}

// Never discard an uncertain payment outcome; reconcile it with the server first.
export function reservationExpired(hold: Reservation, now: number): boolean {
  return hold.phase !== "confirming"
    && now + hold.clockOffsetMs >= hold.expiresAt;
}

export function readReservation(storage: Reader): Reservation | null {
  try {
    const value = JSON.parse(storage.getItem(RESERVATION_KEY) || "null");
    if (!value || typeof value.key !== "string" || !/^[0-9a-f-]{36}$/i.test(value.key)
      || !Number.isFinite(value.expiresAt) || !Number.isFinite(value.clockOffsetMs)
      || !["reserving", "held", "confirming", "cancelling"].includes(value.phase)
      || typeof value.body?.location !== "string" || !Array.isArray(value.body.items)
      || !value.body.items.length || !value.body.items.every((p: { id?: unknown; quantity?: unknown }) =>
        p && typeof p.id === "string" && Number.isInteger(p.quantity) && Number(p.quantity) > 0 && Number(p.quantity) <= 20)) return null;
    return value;
  } catch { return null; }
}
