import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Order } from "../../shared/types";
import "./DeliveryCelebration.css";

const colors = ["#3559c7", "#15a880", "#ffca58", "#ef789f", "#8e78d9"];

export function DeliveryCelebration({ orders }: { orders: Order[] }) {
  const previous = useRef(new Map<string, Order["status"]>());
  const [celebration, setCelebration] = useState<string | null>(null);

  useEffect(() => {
    // Only celebrate a server-confirmed transition seen by this mounted app.
    // Historical deliveries on initial load, reload, or account replacement
    // are not new arrivals. Keeping this outside the order view avoids replays
    // when switching between the store and map.
    const delivered = orders.find(order => order.status === "delivered"
      && previous.current.has(order.id) && previous.current.get(order.id) !== "delivered");
    previous.current = new Map(orders.map(order => [order.id, order.status]));
    if (delivered) setCelebration(delivered.id);
    if (!orders.length) setCelebration(null);
  }, [orders]);

  useEffect(() => {
    if (!celebration) return;
    const timer = window.setTimeout(() => setCelebration(null), 5000);
    return () => clearTimeout(timer);
  }, [celebration]);

  if (!celebration) return null;
  return <div className="delivery-celebration" key={celebration}>
    <div className="delivery-confetti" aria-hidden="true">
      {Array.from({ length: 48 }, (_, index) => <i key={index} style={{
        "--x": `${(index * 37) % 100}%`,
        "--drift": `${((index * 23) % 160) - 80}px`,
        "--delay": `${(index % 8) * 0.07}s`,
        "--duration": `${2.5 + (index % 5) * 0.23}s`,
        "--color": colors[index % colors.length],
        "--rotation": `${360 + (index % 4) * 180}deg`,
      } as CSSProperties} />)}
    </div>
    <div className="delivery-celebration-toast" role="status" aria-live="polite">
      <span aria-hidden="true">🎉</span>
      <div><strong>Delivered. Enjoy!</strong><p>Your simulated delivery has arrived.</p></div>
      <button onClick={() => setCelebration(null)} aria-label="Dismiss delivery celebration">×</button>
    </div>
  </div>;
}
