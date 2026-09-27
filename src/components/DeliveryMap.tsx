/// <reference types="google.maps" />
import { useEffect, useRef, useState } from "react";
import { campusStops, pinEdges, deliveryArea, pickupRoute, pickupStores, GEO_PREPARATION_MS, CORRIDOR_METERS } from "../../shared/campusGeo";
import type { Coordinate, DeliveryPin, GeoRoute } from "../../shared/campusGeo";
import type { CampusStore } from "../hooks/useCampusStore";
import { loadGoogleMaps } from "../lib/googleMaps";
import "./CampusMap.css";

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
  // Update event callbacks without rebuilding the Google map on every render.
  useEffect(() => { handlers.current = { onPick, onReady }; }, [onPick, onReady]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const authError = () => { if (active) { setError("Google Maps authorization failed. Reload after map configuration is restored."); setReady(false); handlers.current.onReady?.(false); } };
    window.addEventListener("campus-map-error", authError);
    const listeners: google.maps.MapsEventListener[] = [];
    void loadGoogleMaps().then(() => {
      if (!active || !element.current) return;
      const map = new google.maps.Map(element.current, { center: { lat: 37.3635, lng: -120.4260 }, zoom: 17,
        mapId: "DEMO_MAP_ID", mapTypeControl: false, streetViewControl: false, clickableIcons: false,
        restriction: { latLngBounds: { north: 37.370, south: 37.358, east: -120.418, west: -120.433 }, strictBounds: true } });
      mapRef.current = map;
      const bounds = new google.maps.LatLngBounds();
      campusStops.forEach(stop => bounds.extend(stop));
      map.fitBounds(bounds, 40);
      pinEdges.forEach(([a, b]) => new google.maps.Polyline({ map, path: [campusStops[a], campusStops[b]],
        strokeColor: "#19817b", strokeOpacity: 0.45, strokeWeight: 12, clickable: false }));

      pickupStores.forEach(store => {
        const tag = document.createElement("span"); tag.className = "map-store-marker"; tag.textContent = store.name;
        new google.maps.marker.AdvancedMarkerElement({ map, position: campusStops[store.node], content: tag, title: `${store.name} · simulated pickup` });
      });
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
  const valid = pin ? deliveryArea(pin) : null;
  const route = pin && valid ? pickupRoute({ ...pin, confirmed: true }, lines.length ? lines.map(p => p.storeId) : ["library"]) : null;
  // Moving a pin invalidates prior consent; checkout needs an explicit reconfirmation.
  function pick(point: Coordinate) { if (locked) return; setPin(point); setDestination(null); setMessage(""); }
  function locate() {
    if (!navigator.geolocation || !window.isSecureContext) { setMessage("Location sharing is unavailable. Place your pin manually."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(result => {
      if (!active.current) return;
      setLocating(false);
      const point = { lat: result.coords.latitude, lng: result.coords.longitude };
      if (deliveryArea(point)) { pick(point); setMessage(`Location accuracy: about ${Math.round(result.coords.accuracy)} m. Check the pin and confirm where you will meet the robot.`); }
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
    <p>Tap along the highlighted sections of Scholars Lane, Mammoth Lakes Road, University Avenue, or the additional campus path. Drag your pin to your meeting point and confirm before checkout.</p>
    <p>Would you like to share your location? This is optional. We read it once to help place your pin; only your confirmed meeting point is saved with checkout.</p>
    <button className="back" disabled={!online || locked || locating || !ready} onClick={locate}>{locating ? "Finding your location…" : "Use my location"}</button>
    <GoogleDeliveryMap pin={pin} route={route} onPick={locked ? undefined : pick} onReady={setReady} />
    <div className="map-points">
      {campusStops.filter((_, index) => pinEdges.some(edge => edge.includes(index))).map(stop => <button className="back" key={stop.id} disabled={locked || !ready || !online} onClick={() => pick(stop)}>{stop.label}</button>)}
    </div>
    <p className="map-notice">Highlighted lines mark customer meeting areas, with a {CORRIDOR_METERS} m pin tolerance. The darker route is a demo animation estimate. A physical robot will use its own safe routing and tracker; those systems are not connected yet. Store markers are simulated pickup points.</p>
    {pin && <p>Pin: {pin.lat.toFixed(6)}, {pin.lng.toFixed(6)} · {valid ? "Within the demo delivery paths" : "Outside the supported paths — choose another point"}</p>}
    {route && <p>Pickup: {route.pickups?.map(p => p.name).join(" → ")} → your pin. About {Math.max(1, Math.ceil((route.seconds + GEO_PREPARATION_MS / 1000) / 60))} minutes including preparation · {route.meters} m simulated travel.</p>}
    {message && <p role="status">{message}</p>}
    {!online && <p role="alert">Reconnect to load the map and confirm your delivery pin.</p>}
    <button className="primary" disabled={!valid || !ready || !online || locked} onClick={confirm}>Confirm this delivery pin</button>
    <button className="back" onClick={() => setView("shop")}>Back to bag</button>
    <p>Demo pickup stores: {pickupStores.map(s => s.name).join(" and ")}. Travel uses Dijkstra on the simulation network, at 1 m/s; it does not predict traffic or real robot delays.</p>
  </section>;
}
