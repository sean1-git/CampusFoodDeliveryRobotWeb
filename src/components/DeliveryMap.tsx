/// <reference types="google.maps" />
import { useEffect, useRef, useState } from "react";
import { campusStops, pinEdges, pinCorridors, deliveryArea, pickupRoute, pickupStores, GEO_PREPARATION_MS, CORRIDOR_METERS } from "../../shared/campusGeo";
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
      const content = document.createElement("img");
      content.src = "/delivery-robot.svg"; content.alt = "Simulated delivery robot";
      content.width = 60; content.height = 48;
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
  
    lineRef.current?.setPath(route?.points ?? []);
  }, [ready, pin, route, onPick]);
  useEffect(() => { if (ready && pin) mapRef.current?.panTo(pin); }, [ready, pin]);
  useEffect(() => { if (ready && robotRef.current) robotRef.current.position = robot ?? null; }, [ready, robot]);
  function showCampus() {
    const bounds = new google.maps.LatLngBounds();
    campusStops.forEach(stop => bounds.extend(stop));
    mapRef.current?.fitBounds(bounds, 40);
  }
  return <div className="friendly-map">
    <div className="map-toolbar"><button className="back" disabled={!ready} onClick={showCampus}>Show campus</button><button className="back" disabled={!ready || !pin} onClick={() => { if (pin) { mapRef.current?.panTo(pin); mapRef.current?.setZoom(19); } }}>Find my pin</button></div>
    {error && <p className="map-notice" role="alert">{error}</p>}
    {!ready && !error && <p role="status">Loading Google Maps…</p>}
    <div ref={element} className="google-map-canvas" aria-label="UC Merced delivery map" />
  </div>;
}

export function DeliveryLocation({ destination, setDestination, locked, online, setView, lines }: Pick<CampusStore,
  "destination" | "setDestination" | "locked" | "online" | "setView" | "lines">) {
  const [pin, setPin] = useState<Coordinate | null>(destination);
  const [ready, setReady] = useState(false);
  const [locating, setLocating] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef(true);
  const locationRequest = useRef(0);
  const useLocationButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; locationRequest.current++; }; }, []);
  useEffect(() => { if (locked) locationRequest.current++; }, [locked]);
  const valid = pin ? deliveryArea(pin) : null;
  const route = pin && valid && lines.length ? pickupRoute({ ...pin, confirmed: true }, lines.map(p => p.storeId)) : null;
  // Moving a pin invalidates prior consent; checkout needs an explicit reconfirmation.
  function pick(point: Coordinate) {
    if (locked) return;
    locationRequest.current++;
    setLocating(false); setPin(point); setDestination(null); setMessage("");
  }
  function removeLocation() {
    if (locked) return;
    // Browser geolocation cannot be cancelled; invalidate its callback so a late fix cannot restore the pin.
    locationRequest.current++;
    setLocating(false); setPin(null); setDestination(null);
    setMessage("Location removed. Choose a new meeting point whenever you’re ready.");
    useLocationButton.current?.focus();
  }
  function locate() {
    if (locked || locating || !online || !ready) return;
    if (!navigator.geolocation || !window.isSecureContext) { setMessage("Location sharing is unavailable. Use the path selector or place your pin manually."); return; }
    const requestId = ++locationRequest.current;
    setLocating(true); setMessage("Waiting for your location. You can cancel at any time.");
    navigator.geolocation.getCurrentPosition(result => {
      if (!active.current || requestId !== locationRequest.current) return;
      setLocating(false);
      const point = { lat: result.coords.latitude, lng: result.coords.longitude };
      if (deliveryArea(point)) { pick(point); setMessage(`Location found, accurate to about ${Math.round(result.coords.accuracy)} meters. Check your pin, then confirm your meeting point.`); }
      else setMessage("Your reported location is outside the delivery paths. Choose a supported path below instead.");
    }, () => {
      if (!active.current || requestId !== locationRequest.current) return;
      setLocating(false); setMessage("Location was unavailable or permission was declined. Use the path selector below; location sharing is optional.");
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }
  function confirm() {
    if (!pin || !valid || !ready || !online || locked) return;
    setDestination({ ...pin, confirmed: true } as DeliveryPin); setView("shop");
  }
  return <section className="campus-delivery">
    <p className="eyebrow">UC MERCED · DELIVERY LOCATION</p>
    <h1>Where should we meet you?</h1>
    <p className="map-intro">Choose a meeting point on a teal path. Tap the map or pick a path below, then confirm your location.</p>
    <div className="location-actions">
      <button type="button" className="location-use-button" ref={useLocationButton} disabled={!online || locked || locating || !ready} aria-describedby="location-privacy" onClick={locate}><span aria-hidden="true">⌖</span> {locating ? "Finding your location…" : "Use my location"}</button>
      <button type="button" className="location-remove-button" disabled={locked || (!pin && !locating)} onClick={removeLocation}>{locating ? "Cancel location request" : "Remove location"}</button>
      <span id="location-privacy">Optional · we check once, not continuously. Removing clears your current meeting point, not previous orders or your browser’s location permission.</span>
    </div>
    <label className="path-picker">Start with a campus path
      <select value="" disabled={locked || !ready || !online} onChange={event => { const stop = campusStops.find(s => s.id === event.target.value); if (stop) pick(stop); }}>
        <option value="" disabled>Choose a path or meeting point…</option>
        {pinCorridors.map(corridor => <optgroup key={corridor.name} label={corridor.name}>
          {[...new Set(corridor.edges.flat())].map(index => <option key={campusStops[index].id} value={campusStops[index].id}>{campusStops[index].label}</option>)}
        </optgroup>)}
      </select>
    </label>
    <GoogleDeliveryMap pin={pin} route={route} onPick={locked || !online ? undefined : pick} onReady={setReady} />
    <div className="map-legend"><span><i className="legend-path" />Available meeting paths</span><span><i className="legend-route" />Simulated delivery route</span><span>Store labels = pickup locations</span></div>
    {message && <p className="map-notice" role="status">{message}</p>}
    <div className={`pin-summary ${pin ? valid ? "pin-valid" : "pin-invalid" : ""}`} role="status" aria-live="polite">
      <span className="pin-summary-icon" aria-hidden="true">{pin ? valid ? "✓" : "!" : "⌖"}</span>
      <div><h2>{pin ? valid ? "Your meeting point is ready" : "Move your pin onto a teal path" : "Choose where to meet your robot"}</h2>
      <p>{pin ? valid ? valid : "This spot is outside the delivery area. Tap closer to a highlighted line." : "Use the map, path selector, or your location to get started."}</p>
      {pin && <small>{pin.lat.toFixed(6)}, {pin.lng.toFixed(6)} · drag the marker to adjust</small>}</div>
    </div>
    {route && lines.length > 0 && <div className="pin-trip"><strong>About {Math.max(1, Math.ceil((route.seconds + GEO_PREPARATION_MS / 1000) / 60))} min</strong><span>{route.pickups?.map(p => p.name).join(" → ")} → your pin<br /><small>Simulated estimate, including preparation and pickup stops</small></span></div>}
    {!online && <p role="alert">You’re offline. Reconnect before confirming your meeting point.</p>}
    {locked && <p role="status">Your checkout is in progress. Finish or cancel it before changing the meeting point.</p>}
    <div className="pin-confirm-bar"><button className="back" onClick={() => setView("shop")}>Back to bag</button><button className="primary" disabled={!valid || !ready || !online || locked} onClick={confirm}>Confirm meeting point →</button></div>
    <details className="map-help"><summary>How delivery locations work</summary><p>Pins must be within {CORRIDOR_METERS} m of a highlighted path. Your exact confirmed point is saved with checkout. Store markers and routes are for the demo; real robot navigation and tracking are not connected.</p></details>
  </section>;
}
