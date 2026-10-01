import { useEffect, useState } from "react";
import { campusEdges, campusNodes, fastestRoute, meetingPoints, positionOnRoute, PREPARATION_MS } from "../../../../../packages/domain/src/campus/campusRouting";
import type { Order } from "../../shared/types";
import "./CampusMap.css";
import { GoogleDeliveryMap } from "./DeliveryMap";
import { geoPosition, deliverySteps } from "../../../../../packages/domain/src/delivery/deliveryRoute";

function useSimulationClock(running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Historical orders never need an animation timer; hidden tabs catch up on return.
    if (!running) return;
    const tick = () => { if (document.visibilityState !== "hidden") setNow(Date.now()); };
    const timer = window.setInterval(tick, 1000);
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
  const estimatedNow = order.serverNow != null && order.receivedAt != null
    ? order.serverNow + Math.max(0, clock - order.receivedAt) : clock;
  const confirmed = order.status === "delivered";
  const now = confirmed ? Math.max(estimatedNow, order.arrivesAt) : estimatedNow;
  const departure = order.departsAt ?? order.createdAt + PREPARATION_MS;
  const awaitingConfirmation = !confirmed && now >= order.arrivesAt;
  // The animation can reach its ETA offline; only the API confirms delivery.
  const progressTime = confirmed ? now : Math.min(now, order.arrivesAt - 1);
  const steps = order.deliveryRoute?.journey
    ? deliverySteps(order.deliveryRoute, order.createdAt, progressTime)
    : ["Preparing", "Robot en route", "Delivered"].map((label, index) => {
      const current = ["preparing", "delivering", "delivered"].indexOf(order.status);
      return { label, state: index < current ? "complete" : index === current ? "current" : "upcoming" };
    });
  const currentStep = steps.find(step => step.state === "current");
  const left = Math.max(0, Math.ceil((order.arrivesAt - now) / 1000));
  const stage = confirmed ? "Delivered. Enjoy your study break."
    : awaitingConfirmation ? "Waiting for delivery confirmation"
    : currentStep?.label ?? "Your robot is on its way";
  return <div className="order-tracking">
    <div className="order-progress-summary">
      <div><p className="eyebrow">SIMULATED DELIVERY</p><h3>{stage}</h3>
        <p>{confirmed ? "Your demo delivery is complete." : awaitingConfirmation
          ? "The estimated arrival time has passed. We’ll update this order when the server confirms."
          : "Follow your robot from the pickup shops to your meeting point."}</p>
      </div>
      {!confirmed && <div className="order-arrival-estimate">
        <span>Estimated arrival</span>
        <strong><time dateTime={new Date(order.arrivesAt).toISOString()}>{new Date(order.arrivesAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></strong>
        <span role="timer" aria-live="off">{awaitingConfirmation ? "Awaiting confirmation" : `${duration(left)} remaining`}</span>
      </div>}
    </div>
    {/* Announce stage transitions, not each frame of the robot or countdown. */}
    <p className="sr-only" role="status">{stage}</p>
    {!online && <p className="order-offline-note" role="status">Offline · showing a saved route and estimated progress. Reconnect for confirmed order updates.</p>}
    <div className="order-tracking-layout">
      {order.deliveryRoute ? <GoogleDeliveryMap mode="tracking" destinationLabel={order.location}
        pin={order.deliveryRoute.destination} route={order.deliveryRoute}
        robot={geoPosition(order.deliveryRoute, (now - departure) / 1000)} />
        : <CampusMap location={order.location} startedAt={departure} now={now} compact />}
      <div className="order-journey">
        <h3>Pickup & delivery</h3>
        <ol className="order-journey-steps" aria-label="Simulated pickup and delivery progress">
          {steps.map((step, index) => {
            const complete = step.state === "complete" || confirmed;
            const finalStep = index === steps.length - 1;
            const state = complete ? "complete" : step.state;
            const pickup = order.deliveryRoute?.journey && index > 0 && index <= (order.deliveryRoute.pickups?.length ?? 0)
              ? order.deliveryRoute.pickups?.[index - 1] : null;
            return <li key={index} className={state} aria-current={!complete && state === "current" ? "step" : undefined}>
              <span className="order-step-number" aria-hidden="true">{complete ? "✓" : index + 1}</span>
              <div><strong>{step.label}</strong>
                <small>{complete ? "Complete" : finalStep && awaitingConfirmation ? "Awaiting confirmation" : state === "current" ? "In progress · estimated" : "Up next"}</small>
                {pickup?.items?.length ? <p>{pickup.items.map(item => `${item.quantity} × ${item.name}`).join(" · ")}</p> : null}
              </div>
            </li>;
          })}
        </ol>
        <div className="order-meeting-point"><span className="eyebrow">YOUR MEETING POINT</span><p>{order.location}</p>
          {order.deliveryRoute && <span className="order-coordinates">{order.deliveryRoute.destination.lat.toFixed(6)}, {order.deliveryRoute.destination.lng.toFixed(6)}</span>}
        </div>
        <details className="order-timing-help"><summary>About this delivery estimate</summary>
          <p>20 seconds of preparation, then a simulated campus trip{order.deliveryRoute?.journey ? " with a 5-second loading stop at each shop" : ""}. All items are collected before delivery.</p>
          {order.deliveryRoute && <p>Saved route: {Math.round(order.deliveryRoute.meters).toLocaleString()} meters. The robot position is animated, not live GPS.</p>}
        </details>
      </div>
    </div>
  </div>;
}
