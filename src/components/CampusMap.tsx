import { useEffect, useState } from "react";
import { campusEdges, campusNodes, fastestRoute, meetingPoints, positionOnRoute, PREPARATION_MS } from "../../shared/campusRouting";
import type { Order } from "../types";
import "./CampusMap.css";

function useSimulationClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 100);
    window.addEventListener("pageshow", tick);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); window.removeEventListener("pageshow", tick); document.removeEventListener("visibilitychange", tick); };
  }, []);
  return now;
}

const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.ceil(seconds % 60)).padStart(2, "0")}`;

export function CampusMap({ location, startedAt, now, compact = false }: {
  location: string; startedAt: number | null; now: number; compact?: boolean;
}) {
  const route = fastestRoute(location);
  if (!route) return <p role="status">No demo path is available for this meeting point.</p>;
  const elapsed = startedAt === null ? 0 : Math.max(0, (now - startedAt) / 1000);
  const robot = positionOnRoute(route, elapsed);
  const arrived = startedAt !== null && elapsed >= route.seconds;
  return (
    <figure className={`campus-map ${compact ? "campus-map-compact" : ""}`}>
      <svg viewBox="0 0 393 508" role="img" aria-label={`Illustrative UC Merced route to ${location}. ${startedAt === null ? "Robot at demo dispatch point." : arrived ? "Simulated robot arrived." : "Simulated robot en route."}`}>
        <image href="/uc-merced-campus.jpg" width="393" height="508" />
        <g className="campus-network">
          {campusEdges.map((edge) => {
            const a = campusNodes.find((node) => node.id === edge.from)!;
            const b = campusNodes.find((node) => node.id === edge.to)!;
            return <line key={`${edge.from}-${edge.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })}
        </g>
        <polyline className="campus-route-halo" points={route.nodes.map((node) => `${node.x},${node.y}`).join(" ")} />
        <polyline className="campus-route" points={route.nodes.map((node) => `${node.x},${node.y}`).join(" ")} />
        {meetingPoints.map((point) => {
          const node = campusNodes.find((node) => node.id === point.id)!;
          return <g key={point.id} transform={`translate(${node.x},${node.y})`}>
            <circle r="10" className={point.label === location ? "campus-pin selected" : "campus-pin"} />
            <text textAnchor="middle" dy="4" className="campus-pin-letter">{point.marker}</text>
          </g>;
        })}
        <rect x="169" y="320" width="14" height="14" rx="3" className="campus-depot" />
        <g transform={`translate(${robot.x},${robot.y})`}>
          <circle r="11" className="campus-robot-halo" />
          <rect x="-7" y="-6" width="14" height="12" rx="4" className="campus-robot" />
          <circle cx="-3" cy="-1" r="1.5" fill="white" /><circle cx="3" cy="-1" r="1.5" fill="white" />
        </g>
      </svg>
      <figcaption>Supplied campus map · approximate demo points and paths, not surveyed robot routes.</figcaption>
    </figure>
  );
}

export function OrderRoute({ order, online }: { order: Order; online: boolean }) {
  const clock = useSimulationClock();
  // Measure elapsed time from receipt, using server time to avoid device-clock skew.
  const now = order.serverNow != null && order.receivedAt != null
    ? order.serverNow + Math.max(0, clock - order.receivedAt) : clock;
  const departure = order.departsAt ?? order.createdAt + PREPARATION_MS;
  const preparing = now < departure;
  const arrived = now >= order.arrivesAt;
  const left = Math.max(0, Math.ceil((order.arrivesAt - now) / 1000));
  return <div className="order-route">
    <CampusMap location={order.location} startedAt={departure} now={now} compact />
    <div className="order-route-info">
      <p className="eyebrow">SIMULATED DELIVERY</p>
      <h3>{arrived ? "Demo arrival complete" : preparing ? "Preparing for dispatch" : "Robot on its demo route"}</h3>
      <p>{arrived ? "The simulated robot reached your selected meeting point." : <>Time to demo arrival: <strong>{duration(left)}</strong></>}</p>
      <p>{preparing ? "20-second preparation, then movement along the highlighted path." : "Route follows estimated travel times in the illustrative network."}</p>
      {!online && <p className="map-notice">Offline: this is a local prediction of the demo timeline, not a live robot position.</p>}
    </div>
  </div>;
}

export function CampusDelivery({ location, setLocation, locked, online, setView }: {
  location: string; setLocation: (location: string) => void; locked: boolean; online: boolean; setView: (view: "shop" | "orders" | "map") => void;
}) {
  const now = useSimulationClock();
  const [run, setRun] = useState<{ location: string; startedAt: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [position, setPosition] = useState<{ latitude: number; longitude: number; accuracy: number; timestamp: number } | null>(null);
  const [locationMessage, setLocationMessage] = useState("");
  const [locationRequest, setLocationRequest] = useState(0);
  // Location is opt-in, ephemeral and never included in checkout/API requests.
  useEffect(() => {
    if (!locationRequest) return;
    let active = true;
    if (!navigator.geolocation || !window.isSecureContext) {
      setLocationMessage("Location is unavailable here. Choose a demo meeting point manually."); setLocating(false); return;
    }
    navigator.geolocation.getCurrentPosition((result) => {
      if (!active) return;
      setPosition({ latitude: result.coords.latitude, longitude: result.coords.longitude, accuracy: result.coords.accuracy, timestamp: result.timestamp });
      setLocating(false);
      setLocationMessage("Location received. This image has no GPS calibration, so select and confirm a demo meeting point below.");
    }, (error) => {
      if (!active) return;
      setLocating(false);
      setLocationMessage(error.code === 1 ? "Location permission was declined or blocked. You can still choose a meeting point." : "Could not get a fresh location. Try again or choose a meeting point manually.");
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 });
    return () => { active = false; };
  }, [locationRequest]);
  const route = fastestRoute(location);
  const currentRun = run?.location === location ? run : null;
  const remaining = currentRun && route ? Math.max(0, Math.ceil(route.seconds - Math.max(0, now - currentRun.startedAt) / 1000)) : null;
  return <section className="campus-delivery">
    <div className="campus-heading"><div><p className="eyebrow">UC MERCED · CAMPUS DELIVERY</p><h1>Try the robot route.</h1><p>Choose a demo meeting point and watch the journey.</p></div><span className="campus-demo-badge">SIMULATION ONLY</span></div>
    <div className="campus-workspace">
      <CampusMap location={location} startedAt={currentRun?.startedAt ?? null} now={now} />
      <div className="campus-controls">
        <div className="campus-control-section">
          <h2>Your meeting point</h2>
          <p>Points A–C and the dispatch point are illustrative placements. They need confirmation on a detailed campus map.</p>
          <label className="field-label" htmlFor="map-destination">Delivery destination</label>
          <select id="map-destination" disabled={locked} value={location} onChange={(event) => { setLocation(event.target.value); setRun(null); }}>
            {meetingPoints.map((point) => <option key={point.id} value={point.label}>{point.marker} · {point.label}</option>)}
          </select>
          {locked && <p className="map-notice">Your checkout has fixed this destination. Cancel the reservation to change it.</p>}
          <button className="secondary" onClick={() => { setLocating(true); setLocationMessage(""); setPosition(null); setLocationRequest((value) => value + 1); }} disabled={locating}>{locating ? "Finding your location…" : "Use my location"}</button>
          <p className="campus-privacy">Optional. Location stays in this browser and is cleared when you leave this view. No background tracking.</p>
          <div role="status" aria-live="polite">
            {locationMessage && <p className="map-notice">{locationMessage}</p>}
            {position && <p className="campus-position">{position.latitude.toFixed(5)}, {position.longitude.toFixed(5)} · accuracy ±{Math.round(position.accuracy)} m<br />Captured {new Date(position.timestamp).toLocaleTimeString()}. Position is not plotted on this uncalibrated image.</p>}
          </div>
        </div>
        <div className="campus-control-section">
          <h2>Route preview</h2>
          <div className="campus-route-metrics"><div><span>ESTIMATED DEMO TRAVEL</span><strong>{route ? duration(route.seconds) : "Unavailable"}</strong></div><div><span>DEMO ARRIVAL IN</span><strong>{remaining === null ? "—" : duration(remaining)}</strong></div></div>
          <p>The highlighted route has the lowest total travel time in this demo network. Timings are simulated, not real-world estimates.</p>
          <div className="campus-buttons"><button className="primary" disabled={!route || (remaining !== null && remaining > 0)} onClick={() => setRun({ location, startedAt: Date.now() })}>{remaining === 0 ? "Run again" : remaining !== null ? "Simulation running…" : "Start simulation"}</button><button className="secondary" disabled={!currentRun} onClick={() => setRun(null)}>Reset</button></div>
          <p role="status" aria-live="polite">{remaining === 0 ? "Arrived at the demo meeting point." : currentRun ? "Robot is following the highlighted path." : "Preview only. Starting a simulation does not place an order."}</p>
          {!online && <p className="map-notice">Offline demo · cached map and simulated movement remain available.</p>}
        </div>
        <div className="campus-legend"><span><i className="legend-route" /> Selected route</span><span><i className="legend-robot" /> Robot</span><span><i className="legend-depot" /> Demo dispatch</span></div>
        <button className="secondary" onClick={() => setView("shop")}>Use this destination in the store →</button>
      </div>
    </div>
  </section>;
}
