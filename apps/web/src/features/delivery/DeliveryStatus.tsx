import { DeliveryProgress } from "./DeliveryProgress";
import type { CampusStore } from "../../app/useCampusStore";
import { deliverySteps } from "../../../../../packages/domain/src/delivery/deliveryRoute";
import { formatOrderCooldown } from "../checkout/orderCooldown";

export function DeliveryStatus({ orders, orderCooldownMs, setView, online }: Pick<CampusStore, "orders" | "orderCooldownMs" | "setView" | "online">) {
  const order = orders.find(o => o.status !== "delivered");
  if (!orderCooldownMs) return null;
  const stage = order?.deliveryRoute?.journey
    ? deliverySteps(order.deliveryRoute, order.createdAt, order.serverNow ?? order.createdAt).find(step => step.state === "current")?.label
    : null;
  const duration = order ? order.arrivesAt - order.createdAt : orderCooldownMs;
  const progress = Math.max(0, Math.min(1, 1 - orderCooldownMs / Math.max(1, duration)));
  return <section className="delivery-status-card" aria-label="Current delivery">
    <div className="delivery-orb" aria-hidden="true"><img src="/delivery-robot.svg" alt="" width="52" height="44" /></div>
    <div className="delivery-status-content">
      <p className="eyebrow">{online ? "DELIVERY IN PROGRESS" : "SAVED DELIVERY ESTIMATE"}</p>
      <h2>{stage ?? (order?.status === "preparing" ? "A little goodness is getting ready." : "Your campus delivery is on its way.")}</h2>
      <p>Ordering opens as soon as the simulated robot reaches your pin.</p>
      <DeliveryProgress value={progress} label="Estimated delivery progress" />
    </div>
    <div className="delivery-countdown"><strong>{formatOrderCooldown(orderCooldownMs)}</strong><span>estimated remaining</span></div>
    <md-filled-tonal-button onClick={() => setView("orders")}>Track delivery <span aria-hidden="true">↗</span></md-filled-tonal-button>
  </section>;
}
