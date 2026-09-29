/// <reference types="google.maps" />
import { currentLocation } from "./location";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { campusStops, campusBoundary, walkwayPaths, walkwayChoices, walkwayMetadata, snapDeliveryPin, deliveryArea, pickupRoute, pickupStores, GEO_PREPARATION_MS, SNAP_METERS } from "../../../../../packages/domain/src/campus/campusGeo";
import type { Coordinate, DeliveryPin, GeoRoute } from "../../../../../packages/domain/src/campus/campusGeo";
import type { CampusStore } from "../../app/useCampusStore";
import { stores } from "../../../../../packages/domain/src/catalog/stores";
import { loadGoogleMaps } from "./googleMaps";
import "./CampusMap.css";
import "./GoogleDeliveryMap.css";

function boundsFor(points: Coordinate[]): google.maps.LatLngBoundsLiteral {
  const bounds = { north: -Infinity, south: Infinity, east: -Infinity, west: Infinity };
  points.forEach(({ lat, lng }) => {
    bounds.north = Math.max(bounds.north, lat); bounds.south = Math.min(bounds.south, lat);
    bounds.east = Math.max(bounds.east, lng); bounds.west = Math.min(bounds.west, lng);
  });
  return bounds;
}
// The imported campus network is fixed for this build; calculate its extent once.
const campusViewBounds = boundsFor([...walkwayPaths.flatMap(path => path.points), ...pickupStores.map(store => campusStops[store.node])]);
const campusRestrictionBounds = boundsFor(campusBoundary);

export const GoogleDeliveryMap = memo(function GoogleDeliveryMap({ pin, onPick, route, robot, onReady, mode = "picker", destinationLabel }: {
  pin?: Coordinate | null; onPick?: (point: Coordinate) => void; route?: GeoRoute | null;
  robot?: Coordinate; onReady?: (ready: boolean) => void;
  mode?: "picker" | "tracking"; destinationLabel?: string;
}) {
  const mapId = useId();
  const tracking = mode === "tracking";
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const robotRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const lineRef = useRef<google.maps.Polyline | null>(null);
  const shopMarkerRefs = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>());
  const fittedRoute = useRef("");
  const handlers = useRef({ onPick, onReady });
  // Update event callbacks without rebuilding the Google map on every render.
  useEffect(() => { handlers.current = { onPick, onReady }; }, [onPick, onReady]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("destination");
  const editable = !!onPick;
  const pickupKey = JSON.stringify(tracking ? route?.pickups?.map(pickup => pickup.id) ?? [] : stores.map(store => store.id));
  const visibleStores = useMemo(() => (JSON.parse(pickupKey) as string[]).flatMap(id => {
    const store = stores.find(entry => entry.id === id), pickup = pickupStores.find(entry => entry.id === id);
    return store && pickup ? [{ ...store, node: pickup.node }] : [];
  }), [pickupKey]);
  useEffect(() => {
    let active = true, unavailable = false;
    const authError = () => {
      unavailable = true;
      if (active) { setError("Google Maps authorization failed. Reload after map configuration is restored."); setReady(false); handlers.current.onReady?.(false); }
    };
    window.addEventListener("campus-map-error", authError);
    const listeners: google.maps.MapsEventListener[] = [];
    const overlays: (google.maps.Polyline | google.maps.Polygon)[] = [];
    const storeMarkers: google.maps.marker.AdvancedMarkerElement[] = [];
    const shopMarkers = shopMarkerRefs.current;
    const removeMarkerListeners: (() => void)[] = [];
    void loadGoogleMaps().then(() => {
      if (!active || unavailable || !element.current) return;
      const map = new google.maps.Map(element.current, { center: { lat: 37.3635, lng: -120.4260 }, zoom: 17,
        mapId: "DEMO_MAP_ID", mapTypeControl: false, streetViewControl: false, clickableIcons: false,
        restriction: { latLngBounds: campusRestrictionBounds, strictBounds: false } });
      mapRef.current = map;
      map.fitBounds(campusViewBounds, 40);
      overlays.push(new google.maps.Polygon({ map, paths: campusBoundary, strokeColor: "#607a98",
        strokeOpacity: 0.35, strokeWeight: 1, fillOpacity: 0, clickable: false }));
      // One overlay per mapped path keeps the full campus network inexpensive to draw.
      let walkwayWeight = (map.getZoom() ?? 15) >= 17 ? 5 : 3;
      const walkwayLines = walkwayPaths.map(path => new google.maps.Polyline({ map, path: path.points,
        strokeColor: "#19817b", strokeOpacity: 0.55, strokeWeight: walkwayWeight, zIndex: 1, clickable: false }));
      overlays.push(...walkwayLines);
      listeners.push(map.addListener("zoom_changed", () => {
        const nextWeight = (map.getZoom() ?? 15) >= 17 ? 5 : 3;
        if (nextWeight === walkwayWeight) return;
        walkwayWeight = nextWeight;
        walkwayLines.forEach(line => line.setOptions({ strokeWeight: walkwayWeight }));
      }));

      const makeClickable = (marker: google.maps.marker.AdvancedMarkerElement, select: () => void) => {
        // The quarterly API handles Tab/arrow/Enter navigation for clickable markers.
        marker.classList.add("delivery-map-marker");
        marker.addEventListener("gmp-click", select);
        removeMarkerListeners.push(() => marker.removeEventListener("gmp-click", select));
      };
      pickupStores.forEach(store => {
        const tag = document.createElement("span"); tag.className = "map-store-marker map-store-photo-marker";
        const photo = document.createElement("img");
        photo.src = stores.find(entry => entry.id === store.id)!.image;
        photo.alt = ""; photo.width = 34; photo.height = 34;
        const label = document.createElement("span"); label.textContent = store.name;
        tag.append(photo, label);
        const marker = new google.maps.marker.AdvancedMarkerElement({ position: campusStops[store.node],
          content: tag, title: `Pickup shop: ${store.name}. Show location details.`, gmpClickable: true, zIndex: 10 });
        makeClickable(marker, () => setSelected(store.id));
        storeMarkers.push(marker); shopMarkers.set(store.id, marker);
      });
      const destination = document.createElement("span");
      destination.className = "map-destination-marker"; destination.textContent = "Meet here";
      const marker = new google.maps.marker.AdvancedMarkerElement({ map, title: "Delivery point. Show meeting location details.",
        content: destination, gmpClickable: true, gmpDraggable: !!handlers.current.onPick, zIndex: 20 });
      makeClickable(marker, () => setSelected("destination"));
      markerRef.current = marker;
      const content = document.createElement("span"); content.className = "map-robot-marker";
      const robotImage = document.createElement("img");
      robotImage.src = "/delivery-robot.svg"; robotImage.alt = "";
      robotImage.width = 60; robotImage.height = 48;
      const robotLabel = document.createElement("span"); robotLabel.textContent = "Robot";
      content.append(robotImage, robotLabel);
      const robotMarker = new google.maps.marker.AdvancedMarkerElement({ map, title: "Simulated robot. Show position details.", content, gmpClickable: true, zIndex: 30 });
      makeClickable(robotMarker, () => setSelected("robot"));
      robotRef.current = robotMarker;
      lineRef.current = new google.maps.Polyline({ map, strokeColor: "#244bd7", strokeWeight: 5, zIndex: 2, clickable: false });
      listeners.push(map.addListener("click", (event: google.maps.MapMouseEvent) => {
        if (event.latLng && handlers.current.onPick) { setSelected("destination"); handlers.current.onPick(event.latLng.toJSON()); }
      }));
      listeners.push(marker.addListener("dragend", () => { const p = marker.position; if (p) handlers.current.onPick?.({ lat: typeof p.lat === "function" ? p.lat() : p.lat, lng: typeof p.lng === "function" ? p.lng() : p.lng }); }));
      if (!unavailable) { setReady(true); handlers.current.onReady?.(true); }
    }).catch((failure: Error) => {
      unavailable = true;
      if (active) { setError(failure.message); setReady(false); handlers.current.onReady?.(false); }
    });
    return () => {
      active = false;
      listeners.forEach(listener => listener.remove());
      removeMarkerListeners.forEach(remove => remove());
      overlays.forEach(overlay => overlay.setMap(null));
      storeMarkers.forEach(marker => { marker.map = null; });
      shopMarkers.clear();
      if (markerRef.current) markerRef.current.map = null;
      if (robotRef.current) robotRef.current.map = null;
      lineRef.current?.setMap(null);
      window.removeEventListener("campus-map-error", authError);
      mapRef.current = null;
    };
  }, []);
  const pinLat = pin?.lat, pinLng = pin?.lng;
  const robotLat = robot?.lat, robotLng = robot?.lng;
  const routePoints = route?.points;
  const routeBounds = useMemo(() => routePoints?.length ? boundsFor(routePoints) : null, [routePoints]);
  const routeIdentity = `${route?.version}:${route?.destination.lat},${route?.destination.lng}:${routePoints?.[0]?.lat},${routePoints?.[0]?.lng}:${pickupKey}`;
  useEffect(() => {
    if (!ready) return;
    shopMarkerRefs.current.forEach((marker, id) => { marker.map = visibleStores.some(store => store.id === id) ? mapRef.current : null; });
  }, [ready, visibleStores]);
  useEffect(() => {
    // A status update or robot tick must never undo the user's camera position.
    if (!ready || !tracking || !routeBounds || fittedRoute.current === routeIdentity) return;
    mapRef.current?.fitBounds(routeBounds, 56);
    fittedRoute.current = routeIdentity;
  }, [ready, tracking, routeBounds, routeIdentity]);
  // Updating robot position or interactivity must not rebuild the route geometry.
  useEffect(() => {
    // A drag can snap back to the same coordinates; still restore the marker then.
    if (ready && markerRef.current) markerRef.current.position = pin ?? null;
  }, [ready, pin]);
  useEffect(() => {
    if (ready && markerRef.current) markerRef.current.gmpDraggable = editable;
  }, [ready, editable]);
  useEffect(() => {
    if (ready) lineRef.current?.setPath(routePoints ?? []);
  }, [ready, routePoints]);
  useEffect(() => {
    if (!ready || pinLat == null || pinLng == null || !editable || !mapRef.current) return;
    // Apply center and zoom together: setZoom can cancel an in-flight panTo.
    mapRef.current.moveCamera({ center: { lat: pinLat, lng: pinLng }, zoom: Math.max(18, mapRef.current.getZoom() ?? 18) });
  }, [ready, pinLat, pinLng, editable]);
  useEffect(() => {
    if (ready && robotRef.current) robotRef.current.position = robotLat == null || robotLng == null ? null : { lat: robotLat, lng: robotLng };
  }, [ready, robotLat, robotLng]);
  function showCampus() {
    mapRef.current?.fitBounds(campusViewBounds, 40);
  }
  function showStore(store: typeof visibleStores[number]) {
    // Shop shortcuts only move the camera; the customer still chooses their own pin.
    setSelected(store.id);
    mapRef.current?.moveCamera({ center: campusStops[store.node], zoom: 18 });
  }
  function showPoint(kind: "destination" | "robot") {
    setSelected(kind);
    const point = kind === "robot" ? robot : pin;
    if (point) mapRef.current?.moveCamera({ center: point, zoom: 19 });
  }
  const selectedStore = visibleStores.find(store => store.id === selected);
  const selectedKind = selectedStore ? "pickup" : selected === "robot" && robot ? "robot" : "destination";
  const selectedPoint = selectedStore ? campusStops[selectedStore.node] : selectedKind === "robot" ? robot : pin;
  const pointTitle = selectedStore?.name ?? (selectedKind === "robot" ? "Simulated robot" : "Delivery point");
  const pointDescription = selectedStore ? tracking ? "Pickup shop for this order." : "Robot pickup location. Choose your meeting point separately."
    : selectedKind === "robot" ? "Estimated position in the delivery simulation."
      : selectedPoint ? destinationLabel || route?.label || "Your selected campus walkway." : "Choose a meeting point using the path selector or map.";
  return <div className={`friendly-map${tracking ? " friendly-map--tracking" : ""}`}>
    <div className="map-panel-heading"><div><strong id={`${mapId}-heading`}>{tracking ? "Delivery map" : "Your campus, connected"}</strong><span>UC Merced · simulated robot delivery</span></div><span className="map-area-badge">Campus only</span></div>
    <div className={tracking ? "map-pickup-controls" : "map-shop-shortcuts"} role="group" aria-label={tracking ? "Pickup stops for this order" : "Pickup shops"}>
      {visibleStores.map((store, index) => <button type="button" className={tracking ? "map-pickup-button" : "map-shop-card"} key={store.id} disabled={!tracking && !ready}
        aria-label={tracking ? `Show ${store.name} pickup details` : `Show ${store.name} pickup location on the map`}
        aria-controls={`${mapId}-details`} aria-pressed={selected === store.id}
        onClick={() => showStore(store)}>
        <img src={store.image} alt="" width="64" height="64" />
        <span><small>{tracking ? `PICKUP ${index + 1}` : "ROBOT PICKUP"}</small><strong>{store.name}</strong>{!tracking && <span>View on map <span aria-hidden="true">↗</span></span>}</span>
      </button>)}
    </div>
    <div className="map-toolbar" role="group" aria-label="Map view and location details">
      {tracking && <button type="button" className="back" disabled={!ready || !routeBounds} onClick={() => { if (routeBounds) mapRef.current?.fitBounds(routeBounds, 56); }}>Fit route</button>}
      <button type="button" className="back" disabled={!ready} onClick={showCampus}>Show campus</button>
      <button type="button" className="back" disabled={!pin || !tracking && !ready} aria-controls={`${mapId}-details`} aria-pressed={selectedKind === "destination"} onClick={() => showPoint("destination")}>{tracking ? "Delivery point" : "Find my pin"}</button>
      {tracking && <button type="button" className="back" disabled={!robot} aria-controls={`${mapId}-details`} aria-pressed={selectedKind === "robot"} onClick={() => showPoint("robot")}>Robot position</button>}
    </div>
    {error && <div className="map-unavailable" role="alert"><strong>Map unavailable</strong>
      <p>{tracking ? "Pickup details, your meeting point, and the delivery timeline are still available. Use the location buttons to read details."
        : "You can review your bag, but Google Maps must load before you can confirm a delivery point. Reload to try again."}</p>
      <small>{error}</small>
    </div>}
    {!ready && !error && <p role="status">Loading Google Maps…</p>}
    <div ref={element} className="google-map-canvas" hidden={!!error} role="region" aria-labelledby={`${mapId}-heading`} aria-describedby={ready && !error ? `${mapId}-help` : undefined} />
    <div className="map-point-details" id={`${mapId}-details`}>
      <div><span className={`map-point-symbol map-point-symbol--${selectedKind}`} aria-hidden="true">{selectedKind === "pickup" ? "↥" : selectedKind === "robot" ? "●" : "⌖"}</span><strong aria-live="polite">{pointTitle}</strong></div>
      <p>{pointDescription}</p>
      {selectedPoint && <p className="map-point-coordinates">Coordinates: {selectedPoint.lat.toFixed(6)}, {selectedPoint.lng.toFixed(6)}</p>}
    </div>
    {ready && !error && <p className="map-keyboard-help" id={`${mapId}-help`}>Use the location buttons to read details. On the map, Tab to a marker, use arrow keys to move between markers, and Enter to select.</p>}
    {!error && <div className="map-legend"><span><i className="legend-path" />Campus walkways</span><span><i className="legend-route" />Delivery route</span><span>Photo markers show pickup shops</span></div>}
    <p className="map-data-credit">Walkway data: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">{walkwayMetadata.attribution}</a>. Highlighted paths are available in this simulation.</p>
  </div>;
});

export function DeliveryLocation({ destination, setDestination, locked, online, setView, lines }: Pick<CampusStore,
  "destination" | "setDestination" | "locked" | "online" | "setView" | "lines">) {
  const [pin, setPin] = useState<Coordinate | null>(destination);
  const [ready, setReady] = useState(false);
  const [locating, setLocating] = useState(false);
  const [message, setMessage] = useState("");
  const locationRequest = useRef({ active: true, id: 0 });
  const useLocationButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const request = locationRequest.current;
    request.active = true;
    return () => { request.active = false; request.id++; };
  }, []);
  useEffect(() => { if (locked) locationRequest.current.id++; }, [locked]);
  const valid = useMemo(() => pin ? deliveryArea(pin) : null, [pin]);
  // Quantities and inventory refreshes don't change the pickup locations or route.
  const pickupStoreKey = JSON.stringify([...new Set(lines.map(line => line.storeId))]);
  const route = useMemo(() => {
    const storeIds: string[] = JSON.parse(pickupStoreKey);
    return pin && valid && storeIds.length ? pickupRoute({ ...pin, confirmed: true }, storeIds) : null;
  }, [pin, valid, pickupStoreKey]);
  // Moving a pin invalidates prior consent; checkout needs an explicit reconfirmation.
  const pick = useCallback((point: Coordinate) => {
    if (locked) return null;
    locationRequest.current.id++;
    const snapped = snapDeliveryPin(point);
    setLocating(false); setPin(snapped?.point ?? null); setDestination(null);
    setMessage(snapped
      ? `Meeting point set on ${snapped.label}${snapped.offsetMeters >= 1 ? `, ${Math.round(snapped.offsetMeters)} meters from where you selected` : ""}. Check the pin, then confirm.`
      : `Choose a point inside UC Merced within ${SNAP_METERS} meters of a highlighted walkway. The previous meeting point has been cleared.`);
    return snapped;
  }, [locked, setDestination]);
  function removeLocation() {
    if (locked) return;
    // Browser geolocation cannot be cancelled; invalidate its callback so a late fix cannot restore the pin.
    locationRequest.current.id++;
    setLocating(false); setPin(null); setDestination(null);
    setMessage("Location removed. Choose a new meeting point whenever you’re ready.");
    useLocationButton.current?.focus();
  }
  function locate() {
    if (locked || locating || !online || !ready) return;
    const requestId = ++locationRequest.current.id;
    setLocating(true); setMessage("Waiting for your location. You can cancel at any time.");
    void currentLocation().then(result => {
      if (!locationRequest.current.active || requestId !== locationRequest.current.id) return;
      setLocating(false);
      const point = { lat: result.coords.latitude, lng: result.coords.longitude };
      const snapped = pick(point);
      if (snapped) setMessage(`Location found, accurate to about ${Math.round(result.coords.accuracy)} meters. Your meeting point is on ${snapped.label}${snapped.offsetMeters >= 1 ? `, ${Math.round(snapped.offsetMeters)} meters from the reported location` : ""}. Check the pin before confirming.`);
    }, () => {
      if (!locationRequest.current.active || requestId !== locationRequest.current.id) return;
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
