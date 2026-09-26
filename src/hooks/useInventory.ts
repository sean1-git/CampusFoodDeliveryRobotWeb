import { useCallback, useEffect, useRef, useState } from "react";
import sampleCatalog from "../../shared/catalog.json";
import type { Catalog } from "../types";
import { requestJson } from "../lib/api";
import { save } from "../lib/storage";
import { INVENTORY_CACHE_KEY, INVENTORY_REFRESH_MS, inventoryNeedsRefresh, readInventorySnapshot } from "../lib/inventoryCache";

export function useInventory(online: boolean) {
  const [snapshot, setSnapshot] = useState(() => {
    try { return readInventorySnapshot(localStorage); } catch { return null; }
  });
  const [unavailable, setUnavailable] = useState(false);
  const latest = useRef(snapshot);
  const inFlight = useRef<Promise<void> | null>(null);
  const refreshInventory = useCallback((force = false): Promise<void> => {
    const versionChanged = latest.current?.catalog.revision !== sampleCatalog.revision;
    if (!navigator.onLine || (!force && !versionChanged && !inventoryNeedsRefresh(latest.current?.fetchedAt ?? null, Date.now()))) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    const task = (async () => {
      try {
        const catalog = await requestJson<Catalog>("/api/catalog");
        const next = { catalog, fetchedAt: Date.now() };
        latest.current = next;
        save(INVENTORY_CACHE_KEY, next);
        setSnapshot(next);
        setUnavailable(false);
      } catch (error) {
        setUnavailable(true);
        throw error;
      } finally { inFlight.current = null; }
    })();
    inFlight.current = task;
    return task;
  }, []);

  useEffect(() => {
    if (!online) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      let failed = false;
      try { await refreshInventory(); } catch { failed = true; }
      if (!stopped) timer = setTimeout(check, failed ? 60000 : Math.max(1000,
        (latest.current?.fetchedAt ?? Date.now()) + INVENTORY_REFRESH_MS - Date.now()));
    }
    void check();
    const wake = () => { if (document.visibilityState === "visible") void refreshInventory().catch(() => {}); };
    document.addEventListener("visibilitychange", wake);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [online, refreshInventory]);

  return {
    catalog: snapshot?.catalog ?? sampleCatalog as Catalog,
    inventoryFetchedAt: snapshot?.fetchedAt ?? null,
    inventoryUnavailable: unavailable,
    refreshInventory,
  };
}
