import { useCallback, useEffect, useRef, useState } from "react";
import sampleCatalog from "../../../../../packages/domain/src/catalog/catalog.json";
import type { Catalog } from "../../shared/types";
import { requestJson } from "../../shared/api/api";
import { save } from "../../shared/state/storage";
import { INVENTORY_CACHE_KEY, INVENTORY_REFRESH_MS, inventoryNeedsRefresh, readInventorySnapshot } from "../../shared/state/inventoryCache";

const visible = () => document.visibilityState !== "hidden";

export function useInventory(online: boolean) {
  const [snapshot, setSnapshot] = useState(() => {
    try { return readInventorySnapshot(localStorage); } catch { return null; }
  });
  const [unavailable, setUnavailable] = useState(false);
  const latest = useRef(snapshot);
  const inFlight = useRef<Promise<void> | null>(null);
  const invalidation = useRef(0);
  const refreshed = useRef(0);
  const invalidateInventory = useCallback(() => { invalidation.current++; }, []);
  const hydrateInventory = useCallback(() => {
    // Other tabs may have fetched newer stock while this tab was asleep.
    try {
      const stored = readInventorySnapshot(localStorage);
      if (stored && stored.fetchedAt > (latest.current?.fetchedAt ?? 0)) {
        latest.current = stored;
        setSnapshot(stored);
      }
    } catch { /* Shared storage is optional. */ }
  }, []);
  const refreshInventory = useCallback((force = false): Promise<void> => {
    if (force) invalidateInventory();
    hydrateInventory();
    const versionChanged = latest.current?.catalog.revision !== sampleCatalog.revision;
    if (!navigator.onLine || !visible()) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    if (refreshed.current === invalidation.current && !versionChanged
      && !inventoryNeedsRefresh(latest.current?.fetchedAt ?? null, Date.now())) return Promise.resolve();
    const task = (async () => {
      try {
        do {
          const version = invalidation.current;
          const catalog = await requestJson<Catalog>("/api/catalog");
          // Only a successful fetch advances age. Cache hydration preserves its timestamp.
          const next = { catalog, fetchedAt: Date.now() };
          latest.current = next;
          save(INVENTORY_CACHE_KEY, next);
          setSnapshot(next);
          setUnavailable(false);
          refreshed.current = version;
          // A mutation during the fetch needs one subsequent read, not a parallel request.
        } while (refreshed.current !== invalidation.current && navigator.onLine && visible());
      } catch (error) {
        setUnavailable(true);
        throw error;
      } finally { inFlight.current = null; }
    })();
    inFlight.current = task;
    return task;
  }, [hydrateInventory, invalidateInventory]);

  useEffect(() => {
    const stored = (event: StorageEvent) => { if (event.key === INVENTORY_CACHE_KEY) hydrateInventory(); };
    window.addEventListener("storage", stored);
    return () => window.removeEventListener("storage", stored);
  }, [hydrateInventory]);

  useEffect(() => {
    if (!online) return;
    let stopped = false, checking = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      clearTimeout(timer);
      if (stopped || checking || !visible()) return;
      checking = true;
      let failed = false;
      try { await refreshInventory(); } catch { failed = true; }
      checking = false;
      if (!stopped && visible()) timer = setTimeout(check, failed ? 60000 : Math.max(1000,
        (latest.current?.fetchedAt ?? Date.now()) + INVENTORY_REFRESH_MS - Date.now()));
    }
    void check();
    const wake = () => { clearTimeout(timer); if (visible()) void check(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    return () => {
      stopped = true; clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
    };
  }, [online, refreshInventory]);

  return {
    catalog: snapshot?.catalog ?? sampleCatalog as Catalog,
    inventoryFetchedAt: snapshot?.fetchedAt ?? null,
    inventoryUnavailable: unavailable,
    refreshInventory,
    invalidateInventory,
  };
}
