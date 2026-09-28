/// <reference types="google.maps" />
import { currentLocation } from "../lib/location";
import { useEffect, useMemo, useRef, useState } from "react";
import { campusStops, campusBoundary, walkwayPaths, walkwayChoices, walkwayMetadata, snapDeliveryPin, deliveryArea, pickupRoute, pickupStores, GEO_PREPARATION_MS, SNAP_METERS } from "../../shared/campusGeo";
import type { Coordinate, DeliveryPin, GeoRoute } from "../../shared/campusGeo";
import type { CampusStore } from "../hooks/useCampusStore";
import { stores } from "../../shared/stores";
import { loadGoogleMaps } from "../lib/googleMaps";
import "./CampusMap.css";

function campusMapBounds() {
  const bounds = new google.maps.LatLngBounds();
  walkwayPaths.forEach(path => path.points.forEach(point => bounds.extend(point)));
  pickupStores.forEach(store => bounds.extend(campusStops[store.node]));
  return bounds;
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
  // Update event callbacks without rebuilding the Google map on every render.
  useEffect(() => { handlers.current = { onPick, onReady }; }, [onPick, onReady]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const authError = () => { if (active) { setError("Google Maps authorization failed. Reload after map configuration is restored."); setReady(false); handlers.current.onReady?.(false); } };
    window.addEventListener("campus-map-error", authError);
    const listeners: google.maps.MapsEventListener[] = [];
    const overlays: (google.maps.Polyline | google.maps.Polygon)[] = [];
    const storeMarkers: google.maps.marker.AdvancedMarkerElement[] = [];
    void loadGoogleMaps().then(() => {
      if (!active || !element.current) return;
      const boundaryBounds = new google.maps.LatLngBounds();
      campusBoundary.forEach(point => boundaryBounds.extend(point));
      const map = new google.maps.Map(element.current, { center: { lat: 37.3635, lng: -120.4260 }, zoom: 17,
        mapId: "DEMO_MAP_ID", mapTypeControl: false, streetViewControl: false, clickableIcons: false,
        restriction: { latLngBounds: boundaryBounds, strictBounds: false } });
      mapRef.current = map;
      map.fitBounds(campusMapBounds(), 40);
      overlays.push(new google.maps.Polygon({ map, paths: campusBoundary, strokeColor: "#607a98",
        strokeOpacity: 0.35, strokeWeight: 1, fillOpacity: 0, clickable: false }));
      // One overlay per mapped path keeps the full campus network inexpensive to draw.
      walkwayPaths.forEach(path => overlays.push(new google.maps.Polyline({ map, path: path.points,
        strokeColor: "#19817b", strokeOpacity: 0.55, strokeWeight: 6, clickable: false })));

      pickupStores.forEach(store => {
        const tag = document.createElement("span"); tag.className = "map-store-marker map-store-photo-marker";
        const photo = document.createElement("img");
        photo.src = stores.find(entry => entry.id === store.id)!.image;
        photo.alt = ""; photo.width = 34; photo.height = 34;
        const label = document.createElement("span"); label.textContent = store.name;
        tag.append(photo, label);
        storeMarkers.push(new google.maps.marker.AdvancedMarkerElement({ map, position: campusStops[store.node], content: tag, title: `${store.name} · simulated pickup` }));
      });
      const marker = new google.maps.marker.AdvancedMarkerElement({ map, title: "Your meeting point on a campus walkway", gmpDraggable: !!handlers.current.onPick });
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
    return () => {
      active = false;
      listeners.forEach(listener => listener.remove());
      overlays.forEach(overlay => overlay.setMap(null));
      storeMarkers.forEach(marker => { marker.map = null; });
      if (markerRef.current) markerRef.current.map = null;
      if (robotRef.current) robotRef.current.map = null;
      lineRef.current?.setMap(null);
      window.removeEventListener("campus-map-error", authError);
      mapRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    if (markerRef.current) { markerRef.current.position = pin ?? null; markerRef.current.gmpDraggable = !!onPick; }
  
    lineRef.current?.setPath(route?.points ?? []);
  }, [ready, pin, route, onPick]);
  useEffect(() => { if (ready && pin) mapRef.current?.panTo(pin); }, [ready, pin]);
  useEffect(() => { if (ready && robotRef.current) robotRef.current.position = robot ?? null; }, [ready, robot]);
  function showCampus() {
    mapRef.current?.fitBounds(campusMapBounds(), 40);
  }
  function showStore(node: number) {
    // Shop shortcuts only move the camera; the customer still chooses their own pin.
    mapRef.current?.panTo(campusStops[node]);
    mapRef.current?.setZoom(18);
  }
  return <div className="friendly-map">
    <div className="map-panel-heading"><div><strong>Your campus, connected</strong><span>UC Merced · simulated robot delivery</span></div><span className="map-area-badge">Campus only</span></div>
    <div className="map-shop-shortcuts" aria-label="Pickup shops">
      {stores.map(store => <button type="button" className="map-shop-card" key={store.id} disabled={!ready}
        aria-label={`Show ${store.name} pickup location on the map`}
        onClick={() => showStore(pickupStores.find(pickup => pickup.id === store.id)!.node)}>
        <img src={store.image} alt="" width="64" height="64" />
        <span><small>ROBOT PICKUP</small><strong>{store.name}</strong><span>View on map <span aria-hidden="true">↗</span></span></span>
      </button>)}
    </div>
    <div className="map-toolbar"><button className="back" disabled={!ready} onClick={showCampus}>Show campus</button><button className="back" disabled={!ready || !pin} onClick={() => { if (pin) { mapRef.current?.panTo(pin); mapRef.current?.setZoom(19); } }}>Find my pin</button></div>
    {error && <p className="map-notice" role="alert">{error}</p>}
    {!ready && !error && <p role="status">Loading Google Maps…</p>}
    <div ref={element} className="google-map-canvas" aria-label="UC Merced delivery map with highlighted pedestrian paths" />
    <div className="map-legend"><span><i className="legend-path" />Campus walkways</span><span><i className="legend-route" />Delivery route</span><span>Photo markers show pickup shops</span></div>
    <p className="map-data-credit">Walkway data: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">{walkwayMetadata.attribution}</a>. Highlighted paths are available in this simulation.</p>
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
  const route = useMemo(() => pin && valid && lines.length ? pickupRoute({ ...pin, confirmed: true }, lines.map(p => p.storeId)) : null, [pin, valid, lines]);
  // Moving a pin invalidates prior consent; checkout needs an explicit reconfirmation.
  function pick(point: Coordinate) {
    if (locked) return null;
    locationRequest.current++;
    const snapped = snapDeliveryPin(point);
    setLocating(false); setPin(snapped?.point ?? null); setDestination(null);
    setMessage(snapped
      ? `Meeting point set on ${snapped.label}${snapped.offsetMeters >= 1 ? `, ${Math.round(snapped.offsetMeters)} meters from where you selected` : ""}. Check the pin, then confirm.`
      : `Choose a point inside UC Merced within ${SNAP_METERS} meters of a highlighted walkway. The previous meeting point has been cleared.`);
    return snapped;
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
    const requestId = ++locationRequest.current;
    setLocating(true); setMessage("Waiting for your location. You can cancel at any time.");
    void currentLocation().then(result => {
      if (!active.current || requestId !== locationRequest.current) return;
      setLocating(false);
      const point = { lat: result.coords.latitude, lng: result.coords.longitude };
      const snapped = pick(point);
      if (snapped) setMessage(`Location found, accurate to about ${Math.round(result.coords.accuracy)} meters. Your meeting point is on ${snapped.label}${snapped.offsetMeters >= 1 ? `, ${Math.round(snapped.offsetMeters)} meters from the reported location` : ""}. Check the pin before confirming.`);
    }, () => {
      if (!active.current || requestId !== locationRequest.current) return;
      setLocating(false); setMessage("Location was unavailable or permission was declined. Use the path selector below; location sharing is optional.");
    });
  }
  function confirm() {
    if (!pin || !valid || !ready || !online || locked) return;
    setDestination({ ...pin, confirmed: true } as DeliveryPin); setView("shop");
  }
  return <section className="campus-delivery">
    <p className="eyebrow">UC MERCED · DELIVERY LOCATION</p>
    <h1>Where should we meet you?</h1>
    <p className="map-intro">Meet your robot on a campus walkway. Tap near any highlighted line and we’ll place your pin on the path, then you can confirm.</p>
    <div className="location-tools">
    <div className="location-actions">
      <button type="button" className="location-use-button" ref={useLocationButton} disabled={!online || locked || locating || !ready} aria-describedby="location-privacy" onClick={locate}><span aria-hidden="true">⌖</span> {locating ? "Finding your location…" : "Use my location"}</button>
      <button type="button" className="location-remove-button" disabled={locked || (!pin && !locating)} onClick={removeLocation}>{locating ? "Cancel location request" : "Remove location"}</button>
      <span id="location-privacy">Optional · a one-time location check. You can remove your pin at any time.</span>
    </div>
    <label className="path-picker">Start with a campus path
      <select value="" disabled={locked || !ready || !online} onChange={event => { const stop = walkwayChoices.find(choice => choice.id === event.target.value); if (stop) pick(stop); }}>
        <option value="" disabled>Choose a path or meeting point…</option>
        {walkwayChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
    </label>
    </div>
    <GoogleDeliveryMap pin={pin} route={route} onPick={locked || !online ? undefined : pick} onReady={setReady} />
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
    <details className="map-help"><summary>How delivery locations work</summary><p>Select inside campus within {SNAP_METERS} m of a highlighted walkway. Your pin snaps onto the mapped path, and that meeting point is saved with checkout. Highlighted walkways connect to the pickup shops; stairs, private paths, and paths without a mapped connection are excluded. Map data can be incomplete.</p><p>Removing a pin clears the current meeting point, not previous orders or device location permission. This is a delivery simulation; a real robot needs its own verified navigation and live tracking.</p></details>
  </section>;
}
