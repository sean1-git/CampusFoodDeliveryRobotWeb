/// <reference types="google.maps" />
import { useEffect, useRef, useState } from "react";
import { campusStops, geoEdges, pickupRoute, pickupStores, routeToPin } from "../../shared/campusGeo";
import type { Coordinate, DeliveryPin, GeoRoute } from "../../shared/campusGeo";
import type { CampusStore } from "../hooks/useCampusStore";
import "./CampusMap.css";

let mapLoad: Promise<void> | undefined;
function loadMaps() {
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

export function GoogleDeliveryMap({ pin, onPick, route, robot, onReady }: {
  pin?: Coordinate | null; onPick?: (point: Coordinate) => void; route?: GeoRoute | null;
  robot?: Coordinate; onReady?: (ready: boolean) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const robotRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const lineRef = useRef<google.maps.Polyline | null>(null);
  const handlers = useRef({ onPick, onReady });
  handlers.current = { onPick, onReady };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const authError = () => { if (active) { setError("Google Maps authorization failed. Reload after map configuration is restored."); setReady(false); handlers.current.onReady?.(false); } };
    window.addEventListener("campus-map-error", authError);
    const listeners: google.maps.MapsEventListener[] = [];
    void loadMaps().then(() => {
      if (!active || !element.current) return;
      const map = new google.maps.Map(element.current, { center: { lat: 37.3647, lng: -120.4254 }, zoom: 17,
        mapId: "DEMO_MAP_ID", mapTypeControl: false, streetViewControl: false, clickableIcons: false,
        restriction: { latLngBounds: { north: 37.370, south: 37.358, east: -120.418, west: -120.433 }, strictBounds: true } });
      mapRef.current = map;
      geoEdges.forEach(([a, b]) => new google.maps.Polyline({ map, path: [campusStops[a], campusStops[b]],
        strokeColor: "#19817b", strokeOpacity: 0.45, strokeWeight: 12, clickable: false }));
      campusStops.forEach(stop => new google.maps.marker.AdvancedMarkerElement({ map, position: stop, title: `${stop.label} · demo anchor` }));
      const marker = new google.maps.marker.AdvancedMarkerElement({ map, title: "Your exact delivery pin", gmpDraggable: !!handlers.current.onPick });
      markerRef.current = marker;
      const content = document.createElement("span"); content.textContent = "🤖"; content.style.fontSize = "30px";
      robotRef.current = new google.maps.marker.AdvancedMarkerElement({ map, title: "Simulated robot", content });
      lineRef.current = new google.maps.Polyline({ map, strokeColor: "#174b42", strokeWeight: 5, clickable: false });
      listeners.push(map.addListener("click", (event: google.maps.MapMouseEvent) => { if (event.latLng) handlers.current.onPick?.(event.latLng.toJSON()); }));
      listeners.push(marker.addListener("dragend", () => { const p = marker.position; if (p) handlers.current.onPick?.({ lat: typeof p.lat === "function" ? p.lat() : p.lat, lng: typeof p.lng === "function" ? p.lng() : p.lng }); }));
      setReady(true); handlers.current.onReady?.(true);
    }).catch((failure: Error) => { if (active) { setError(failure.message); handlers.current.onReady?.(false); } });
    return () => { active = false; listeners.forEach(l => l.remove()); window.removeEventListener("campus-map-error", authError); mapRef.current = null; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    if (markerRef.current) { markerRef.current.position = pin ?? null; markerRef.current.gmpDraggable = !!onPick; }
    if (pin) mapRef.current?.panTo(pin);
    lineRef.current?.setPath(route?.points ?? []);
  }, [ready, pin, route, onPick]);
  useEffect(() => { if (ready && robotRef.current) robotRef.current.position = robot ?? null; }, [ready, robot]);
  return <div>
    {error && <p className="map-notice" role="alert">{error}</p>}
    {!ready && !error && <p role="status">Loading Google Maps…</p>}
    <div ref={element} style={{ height: 440, width: "100%", borderRadius: 16 }} aria-label="UC Merced delivery map" />
  </div>;
}

export function DeliveryLocation({ destination, setDestination, locked, online, setView, lines }: Pick<CampusStore,
  "destination" | "setDestination" | "locked" | "online" | "setView" | "lines">) {
  const [pin, setPin] = useState<Coordinate | null>(destination);
  const [ready, setReady] = useState(false);
  const [locating, setLocating] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const valid = pin ? routeToPin(pin) : null;
  const route = pin && valid ? pickupRoute({ ...pin, confirmed: true }, lines.length ? lines.map(p => p.storeId) : ["library"]) : null;
  function pick(point: Coordinate) { if (locked) return; setPin(point); setDestination(null); setMessage(""); }
  function locate() {
    if (!navigator.geolocation || !window.isSecureContext) { setMessage("Location sharing is unavailable. Place your pin manually."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(result => {
      if (!active.current) return;
      setLocating(false);
      const point = { lat: result.coords.latitude, lng: result.coords.longitude };
      if (routeToPin(point)) { pick(point); setMessage(`Location accuracy: about ${Math.round(result.coords.accuracy)} m. Check the pin and confirm where you will meet the robot.`); }
      else setMessage(`Your reported location is outside the supported paths (accuracy about ${Math.round(result.coords.accuracy)} m). Place a pin on a highlighted path manually.`);
    }, () => { if (active.current) { setLocating(false); setMessage("Location was unavailable or permission was declined. You can still place your pin manually."); } }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }
  function confirm() {
    if (!pin || !valid || !ready || !online || locked) return;
    setDestination({ ...pin, confirmed: true } as DeliveryPin); setView("shop");
  }
  return <section className="campus-delivery">
    <p className="eyebrow">UC MERCED · DELIVERY LOCATION</p>
    <h1>Where should we meet you?</h1>
    <p>Place an exact pin on a highlighted demo path. Your order cannot be processed until you confirm a supported location.</p>
    <p>Would you like to share your location? This is optional. We read it once to help place your pin; only your confirmed meeting point is saved with checkout.</p>
    <button className="back" disabled={!online || locked || locating || !ready} onClick={locate}>{locating ? "Finding your location…" : "Use my location"}</button>
    <GoogleDeliveryMap pin={pin} route={route} onPick={locked ? undefined : pick} onReady={setReady} />
    <div className="map-points">
      {campusStops.map(stop => <button className="back" key={stop.id} disabled={locked || !ready || !online} onClick={() => pick(stop)}>{stop.label}</button>)}
    </div>
    <p className="map-notice">Simulation paths connect the three supplied coordinates. Pickup markers use nearby demo anchors, not surveyed store entrances. Sidewalk geometry must be verified before physical robot delivery.</p>
    {pin && <p>Pin: {pin.lat.toFixed(6)}, {pin.lng.toFixed(6)} · {valid ? "Within the demo delivery paths" : "Outside the supported paths — choose another point"}</p>}
    {route && <p>Pickup: {route.pickups?.map(p => p.name).join(" → ")} → your pin. About {Math.max(1, Math.ceil((route.seconds + 20) / 60))} minutes including preparation · {route.meters} m simulated travel.</p>}
    {message && <p role="status">{message}</p>}
    {!online && <p role="alert">Reconnect to load the map and confirm your delivery pin.</p>}
    <button className="primary" disabled={!valid || !ready || !online || locked} onClick={confirm}>Confirm this delivery pin</button>
    <button className="back" onClick={() => setView("shop")}>Back to bag</button>
    <p>Demo pickup stores: {pickupStores.map(s => s.name).join(" and ")}. Travel uses Dijkstra on the simulation network, at 1 m/s; it does not predict traffic or real robot delays.</p>
  </section>;
}
