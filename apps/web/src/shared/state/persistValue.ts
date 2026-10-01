const INVENTORY_KEY = "campus-inventory-v1";
export const MAX_INVENTORY_BYTES = 256 * 1024;

// The catalog is disposable. Cart and uncertain checkout IDs are not.
export function persistValue(storage: Pick<Storage, "setItem" | "removeItem">, key: string, value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    if (key === INVENTORY_KEY && json.length * 2 > MAX_INVENTORY_BYTES) {
      storage.removeItem(INVENTORY_KEY);
      return false;
    }
    try { storage.setItem(key, json); }
    catch {
      storage.removeItem(INVENTORY_KEY);
      if (key === INVENTORY_KEY) return false;
      storage.setItem(key, json);
    }
    return true;
  } catch { return false; }
}
