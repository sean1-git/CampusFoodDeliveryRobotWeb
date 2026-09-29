import type { Product } from "../../shared/types";

export function inventoryTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000
    ? value : null;
}

export function inventoryFreshnessLabel(product: Pick<Product, "stockUpdatedAt" | "syncedAt">): string {
  const changed = inventoryTimestamp(product.stockUpdatedAt);
  const synced = inventoryTimestamp(product.syncedAt);
  const syncLabel = synced === null ? "Not yet synced with the inventory source."
    : `Last synced with inventory source: ${new Date(synced).toLocaleString()}.`;
  return changed === null ? `${syncLabel} Source stock-change time unavailable.`
    : `Source-reported stock change: ${new Date(changed).toLocaleString()}. ${syncLabel}`;
}
