// Share one SDK load across the picker and tracking map, including React remounts.
let mapLoad: Promise<void> | undefined;
export function loadGoogleMaps() {
  if (!mapLoad) mapLoad = (async () => {
    const response = await fetch("/api/maps-config", { cache: "no-store" });
    if (!response.ok) throw new Error("Map configuration could not be loaded.");
    const { apiKey } = await response.json();
    if (!apiKey) throw new Error("Google Maps is not configured. Delivery checkout is unavailable.");
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      const globals = window as unknown as Record<string, unknown>;
      const timer = window.setTimeout(() => reject(new Error("Google Maps timed out. Reload while online to retry.")), 20000);
      globals.campusMapReady = () => { clearTimeout(timer); resolve(); };
      globals.gm_authFailure = () => { clearTimeout(timer); window.dispatchEvent(new Event("campus-map-error")); reject(new Error("Google Maps authorization failed. Delivery checkout is unavailable.")); };
      script.src = `https://maps.googleapis.com/maps/api/js?${new URLSearchParams({ key: apiKey, loading: "async", callback: "campusMapReady", libraries: "marker", v: "quarterly" })}`;
      script.async = true;
      script.onerror = () => { clearTimeout(timer); reject(new Error("Google Maps could not load. Reconnect and reload to retry.")); };
      document.head.append(script);
    });
  })();
  return mapLoad;
}

