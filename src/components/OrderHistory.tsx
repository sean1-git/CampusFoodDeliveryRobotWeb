/**
 * Displays orders and their simulated delivery progress from the API.
 * The store hook refreshes this data; this component only renders it.
 */
import { money } from "../lib/money";
import type { CampusStore } from "../hooks/useCampusStore";
import { Bag } from "./BagIcon";
import { OrderRoute } from "./CampusMap";

type Props = Pick<CampusStore, "orders" | "setView" | "online">;
export function OrderHistory({ orders, setView, online }: Props) {
  return (
    <section className="orders-view">
      <p className="eyebrow">FROM OUR STORE TO YOUR DOOR</p>
      <div className="orders-heading">
        <div>
          <h1>Your orders.</h1>
          <p>Follow your demo delivery, one step at a time.</p>
        </div>
        <md-filled-tonal-button onClick={() => setView("shop")}>
          Keep browsing →
        </md-filled-tonal-button>
      </div>
      <p className="simulation-note">
        Demo timeline: 20 seconds to prepare, then a simulated trip along the
        campus route with a 5-second loading stop per store for new orders. Order status refreshes every 5 seconds while connected.
      </p>
      {orders.length === 0 ? (
        <div className="empty-orders">
          <Bag size={48} />
          <h2>Your first delivery is waiting.</h2>
          <p>Place a demo order to see the journey here.</p>
          <button className="primary" onClick={() => setView("shop")}>
            Explore the store
          </button>
        </div>
      ) : (
        orders.map((order) => (
          <article className="order-card" key={order.id}>
            <div className="order-top">
              <div>
                <span className="eyebrow">
                  ORDER {order.id.slice(0, 8).toUpperCase()}
                </span>
                <h2>
                  {order.status === "preparing"
                    ? "Good things are on the way."
                    : order.status === "delivering"
                      ? "Your delivery buddy is on its way."
                      : "Delivered. Enjoy your study break."}
                </h2>
              </div>
              <span className={`status ${order.status}`}>{order.status}</span>
            </div>
            {!order.deliveryRoute?.journey && <ol className="timeline">
              {["preparing", "delivering", "delivered"].map((step, index) => (
                <li
                  key={step}
                  className={
                    ["preparing", "delivering", "delivered"].indexOf(
                      order.status,
                    ) >= index
                      ? "done"
                      : ""
                  }
                >
                  <span>{index + 1}</span>
                  {step === "preparing"
                    ? "Preparing your order"
                    : step === "delivering"
                      ? "Robot en route"
                      : "Delivered"}
                </li>
              ))}
            </ol>}
            <p className="delivery-eta" role="status">
              {order.status === "preparing" ? (
                <>
                  Simulated delivery target: {new Date(order.arrivesAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}.
                </>
              ) : order.status === "delivering" ? (
                <>Estimated delivery at the site: {new Date(order.arrivesAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })} (demo estimate).</>
              ) : (
                <>Simulated delivery completed. No physical robot was dispatched.</>
              )}
            </p>
            <OrderRoute order={order} online={online} />
            <div className="order-info">
              <div>
                <span>MEETING POINT</span>
                <strong>{order.location}</strong>
              </div>
              <div>
                <span>PLACED</span>
                <strong>
                  {new Date(order.createdAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </strong>
              </div>
              <div>
                <span>DEMO TOTAL</span>
                <strong>{money(order.totalCents)}</strong>
              </div>
            </div>
            <div className="order-items">
              {order.items.map((item) => (
                <span key={item.id}>
                  {item.quantity} × {item.name}
                </span>
              ))}
            </div>
          </article>
        ))
      )}
    </section>
  );
}
