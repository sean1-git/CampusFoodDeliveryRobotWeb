import { useEffect, useState } from "react";
import { campusEdges, campusNodes, fastestRoute, meetingPoints, positionOnRoute, PREPARATION_MS } from "../../shared/campusRouting";
import type { Order } from "../types";
import "./CampusMap.css";
import { GoogleDeliveryMap } from "./DeliveryMap";
import { geoPosition, deliverySteps } from "../../shared/campusGeo";

function useSimulationClock(running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Historical orders never need an animation timer; hidden tabs catch up on return.
    if (!running) return;
    const tick = () => { if (document.visibilityState !== "hidden") setNow(Date.now()); };
    const timer = window.setInterval(tick, 250);
    window.addEventListener("pageshow", tick);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); window.removeEventListener("pageshow", tick); document.removeEventListener("visibilitychange", tick); };
  }, [running]);
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
  const clock = useSimulationClock(order.status !== "delivered");
  // Measure elapsed time from receipt, using server time to avoid device-clock skew.
  const now = order.serverNow != null && order.receivedAt != null
    ? order.serverNow + Math.max(0, clock - order.receivedAt) : clock;
  const departure = order.departsAt ?? order.createdAt + PREPARATION_MS;
  const preparing = now < departure;
  const arrived = now >= order.arrivesAt;
  const steps = order.deliveryRoute?.journey ? deliverySteps(order.deliveryRoute, order.createdAt, now) : null;
  const currentStep = steps?.find(step => step.state === "current");
  const left = Math.max(0, Math.ceil((order.arrivesAt - now) / 1000));
  return <div className="order-route">
    {steps && <ol className="pickup-timeline" aria-label="Simulated pickup and delivery progress">
      {steps.map((step, index) => <li key={index} className={step.state} aria-current={step.state === "current" ? "step" : undefined}>
        <span aria-hidden="true">{step.state === "complete" ? "✓" : index + 1}</span>
        <div><strong>{step.label}</strong><small>{(step.state === "complete" || index === steps.length - 1 && arrived) ? "Complete" : step.state === "current" ? "In progress · simulated" : "Up next"}</small>{index > 0 && index <= (order.deliveryRoute?.pickups?.length ?? 0) && <small>{order.deliveryRoute?.pickups?.[index - 1].items?.map(item => `${item.quantity} × ${item.name}`).join(" · ")}</small>}</div>
      </li>)}
    </ol>}
    {order.deliveryRoute ? <GoogleDeliveryMap pin={order.deliveryRoute.destination} route={order.deliveryRoute}
      robot={geoPosition(order.deliveryRoute, (now - departure) / 1000)} /> : <CampusMap location={order.location} startedAt={departure} now={now} compact />}
    <div className="order-route-info">
      <p className="eyebrow">SIMULATED DELIVERY</p>
      <h3>{currentStep?.label ?? (arrived ? "Demo arrival complete" : preparing ? "Preparing for dispatch" : "Robot on its demo route")}</h3>
      <p>{arrived ? "The simulated robot reached your selected meeting point." : <>Time to demo arrival: <strong>{duration(left)}</strong></>}</p>
      {order.deliveryRoute && <p>Pickup: {order.deliveryRoute.pickups?.map(p => p.name).join(" → ")} → confirmed pin at {order.deliveryRoute.destination.lat.toFixed(6)}, {order.deliveryRoute.destination.lng.toFixed(6)}. {order.deliveryRoute.meters} m on the demo network.</p>}
      <p>{preparing ? "20-second preparation, then store pickups and delivery along the highlighted path." : "Route follows estimated travel times in the illustrative network."}</p>
      {order.deliveryRoute?.journey && <p>Each pickup includes a 5-second simulated loading stop. All items are collected before delivery to your pin.</p>}
      {!online && <p className="map-notice">Offline: this is a local prediction of the demo timeline, not a live robot position.</p>}
    </div>
  </div>;
}
