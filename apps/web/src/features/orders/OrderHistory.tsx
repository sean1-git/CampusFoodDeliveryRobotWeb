import { useId, useState } from "react";
import { money } from "../../shared/utils/money";
import type { CampusStore } from "../../app/useCampusStore";
import type { Order } from "../../shared/types";
import { Bag } from "../../shared/ui/BagIcon";
import { OrderRoute } from "../delivery/CampusMap";
import "./OrderHistory.css";

type Props = Pick<CampusStore, "orders" | "setView" | "online">;
const statusLabels = { preparing: "Preparing", delivering: "On the way", delivered: "Delivered" };
const placedAt = (timestamp: number) => new Date(timestamp).toLocaleString([], {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

function OrderCard({ order, online }: { order: Order; online: boolean }) {
  // Keep an open delivery open when it completes; only past orders start collapsed.
  const [expanded, setExpanded] = useState(order.status !== "delivered");
  const id = useId();
  const quantity = order.items.reduce((count, item) => count + item.quantity, 0);
  const shortId = order.id.slice(0, 8).toUpperCase();
  return <article className="order-record" aria-labelledby={`${id}-title`}>
    <div className="order-record-heading">
      <div className="order-record-identity">
        <span className="eyebrow">ORDER #{shortId}</span>
        <h2 id={`${id}-title`}>{order.status === "delivered" ? "Delivered to your meeting point" : "Your campus delivery"}</h2>
        <p><time dateTime={new Date(order.createdAt).toISOString()}>{placedAt(order.createdAt)}</time><span aria-hidden="true"> · </span>{quantity} {quantity === 1 ? "item" : "items"}<span aria-hidden="true"> · </span><strong>{money(order.totalCents)}</strong></p>
      </div>
      <div className="order-record-actions">
        <span className={`order-status order-status-${order.status}`} role="status"><span aria-hidden="true">{order.status === "delivered" ? "✓" : "●"}</span> {statusLabels[order.status]}</span>
        <button type="button" className="order-details-toggle" aria-expanded={expanded} aria-controls={`${id}-details`}
          aria-label={`${expanded ? "Hide" : "Show"} details for order ${shortId}`} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide details" : "View details"} <span aria-hidden="true">{expanded ? "−" : "+"}</span>
        </button>
      </div>
    </div>
    {/* Unmount closed maps so a long order history does not load dozens of maps. */}
    <div id={`${id}-details`} hidden={!expanded}>
      {expanded && <>
        <OrderRoute order={order} online={online} />
        <section className="order-receipt" aria-labelledby={`${id}-items`}>
          <div>
            <h3 id={`${id}-items`}>Items in this order</h3>
            <ul className="order-receipt-items">{order.items.map(item => <li key={item.id}>
              <span><span className="order-item-quantity">{item.quantity} ×</span> {item.name}</span>
              <strong>{money(item.quantity * item.priceCents)}</strong>
            </li>)}</ul>
          </div>
          <dl className="order-receipt-totals">
            <div><dt>Subtotal</dt><dd>{money(order.subtotalCents)}</dd></div>
            <div><dt>Demo delivery</dt><dd>{money(order.deliveryFeeCents)}</dd></div>
            <div className="order-receipt-total"><dt>Demo total</dt><dd>{money(order.totalCents)}</dd></div>
          </dl>
        </section>
      </>}
    </div>
  </article>;
}

export function OrderHistory({ orders, setView, online }: Props) {
  return <section className="orders-view orders-workspace" aria-labelledby="my-orders-title">
    <div className="orders-page-heading">
      <div><p className="eyebrow">UC MERCED · CAMPUS STORE</p><h1 id="my-orders-title">My orders.</h1><p>Your pickups, your meeting point, all in one place.</p></div>
      <md-filled-tonal-button onClick={() => setView("shop")}>Keep browsing <span aria-hidden="true">↗</span></md-filled-tonal-button>
    </div>
    <p className="orders-demo-note"><span aria-hidden="true">ⓘ</span> Demo deliveries follow a simulated timeline. No physical robot is dispatched.</p>
    {orders.length === 0 ? <div className="empty-orders">
      <Bag size={48} /><h2>Your first delivery is waiting.</h2><p>Place a demo order to follow its journey here.</p>
      <button className="primary" onClick={() => setView("shop")}>Explore the store</button>
    </div> : <div className="orders-list">{orders.map(order => <OrderCard key={order.id} order={order} online={online} />)}</div>}
  </section>;
}
