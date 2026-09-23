/**
 * Displays bag quantities, estimated totals, and the delivery-location form.
 * Checkout calls the store hook; the server validates prices and demo funds.
 */
import { money } from "../lib/money";
import { formatOrderCooldown } from "../lib/orderCooldown";
import type { CampusStore } from "../hooks/useCampusStore";
import { Bag } from "./BagIcon";

type Props = Pick<
  CampusStore,
  | "catalog"
  | "quantity"
  | "pending"
  | "lines"
  | "cart"
  | "locked"
  | "change"
  | "subtotal"
  | "total"
  | "checkout"
  | "placeOrder"
  | "location"
  | "setLocation"
  | "session"
  | "online"
  | "submitting"
  | "beginCheckout"
  | "cancelCheckout"
  | "reservation"
  | "secondsLeft"
  | "orderCooldownMs"
  | "nextOrderAt"
>;

export function ShoppingBag({
  catalog,
  quantity,
  pending,
  lines,
  cart,
  locked,
  change,
  subtotal,
  total,
  checkout,
  placeOrder,
  location,
  setLocation,
  session,
  online,
  submitting,
  beginCheckout,
  cancelCheckout,
  reservation,
  secondsLeft,
  orderCooldownMs,
  nextOrderAt,
}: Props) {
  return (
    <aside className="bag-panel" id="bag">
      <div className="bag-title">
        <h2>
          <Bag /> Your bag
        </h2>
        <span>
          {quantity} {quantity === 1 ? "item" : "items"}
        </span>
      </div>
      {quantity === 0 && !pending && !reservation ? (
        <div className="empty-bag">
          <span className="empty-icon">
            <Bag size={36} />
          </span>
          <h3>A little something for later?</h3>
          <p>Add a campus favorite to get started.</p>
        </div>
      ) : (
        <>
          <div className="bag-lines">
            {lines.map((p) => (
              <div className="bag-line" key={p.id}>
                <span
                  className="bag-emoji"
                  style={{ backgroundColor: p.color }}
                  aria-hidden="true"
                >
                  {p.emoji}
                </span>
                <div>
                  <strong>{p.name}</strong>
                  <div className="quantity">
                    <button
                      disabled={locked}
                      onClick={() => change(p, -1)}
                      aria-label={`Remove one ${p.name}`}
                    >
                      −
                    </button>
                    <span>{cart[p.id]}</span>
                    <button
                      disabled={locked || cart[p.id] >= Math.min(20, p.stock ?? 20)}
                      onClick={() => change(p, 1)}
                      aria-label={`Add one ${p.name}`}
                    >
                      +
                    </button>
                  </div>
                </div>
                <span>{money(p.priceCents * cart[p.id])}</span>
              </div>
            ))}
          </div>
          <div className="totals">
            <div>
              <span>Subtotal</span>
              <span>{money(subtotal)}</span>
            </div>
            <div>
              <span>Robot delivery</span>
              <span>{money(catalog.deliveryFeeCents)}</span>
            </div>
            <div className="grand-total">
              <strong>Total</strong>
              <strong>{money(total)}</strong>
            </div>
          </div>
          {checkout || pending ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void placeOrder();
              }}
            >
              <label className="field-label" htmlFor="location">
                Meet your delivery at
              </label>
              <select
                id="location"
                value={reservation?.body.location ?? pending?.body.location ?? location}
                disabled={locked}
                onChange={(event) => setLocation(event.target.value)}
              >
                {catalog.locations.map((place) => (
                  <option key={place}>{place}</option>
                ))}
              </select>
              <div className="payment-method">
                <span>▤ &nbsp; Demo campus wallet</span>
                <strong>
                  {session ? money(session.balanceCents) : "Unavailable"}
                </strong>
              </div>
              <p className="checkout-note">
                This is a simulation. No real money will be charged and no
                physical robot will move.
                {" "}Limited stock goes to the first valid checkout received.
              </p>
              {reservation && (
                <p className="checkout-note" role="status">
                  {reservation.phase === "held"
                    ? <>Items reserved · <strong>{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</strong> remaining. Unconfirmed checkout expires and all items are removed, even offline.</>
                    : reservation.phase === "reserving"
                      ? "Checking availability. Items are not reserved until the server confirms."
                      : "Checking your last request. Keep the same checkout to avoid a duplicate purchase."}
                </p>
              )}
              <button
                className="primary"
                type="submit"
                disabled={!online || !session || submitting || reservation?.phase === "cancelling"}
              >
                {submitting
                  ? "Checking your checkout…"
                  : pending || (reservation && reservation.phase !== "held")
                    ? "Retry this checkout"
                    : "Confirm demo purchase"}
              </button>
              {reservation && reservation.phase !== "confirming" && (
                <button
                  type="button"
                  className="back"
                  disabled={!online || !session || submitting}
                  onClick={() => void cancelCheckout()}
                >
                  Cancel reservation & edit bag
                </button>
              )}
            </form>
          ) : (
            <>
              <label className="field-label" htmlFor="bag-location">Delivery location</label>
              <select id="bag-location" value={location} onChange={(event) => setLocation(event.target.value)}>
                {catalog.locations.map((place) => <option key={place}>{place}</option>)}
              </select>
              <p className="checkout-note">
                {orderCooldownMs > 0 && nextOrderAt
                  ? <>One robot order per hour. Multiple order requests are blocked. Time remaining: <strong>{formatOrderCooldown(orderCooldownMs)}</strong>; your next order is available at {new Date(nextOrderAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</>
                  : <>Enter checkout to hold your items for five minutes. Your wallet is charged only when you confirm.</>}
              </p>
              <button
              className="primary"
              disabled={!online || !session || submitting || orderCooldownMs > 0}
              onClick={() => void beginCheckout()}
            >
              {orderCooldownMs > 0 ? "Order available later" : <>Reserve & review order <span>→</span></>}
              </button>
            </>
          )}
          {pending && (
            <p className="checkout-note">
              A checkout is awaiting confirmation. Retrying uses the same
              request, so you won’t be charged twice.
            </p>
          )}
        </>
      )}
      <div className="bag-foot">
        <span>◎</span>
        <div>
          <strong>A short trip. A small footprint.</strong>
          <p>Explore a new way to get campus essentials.</p>
        </div>
      </div>
    </aside>
  );
}
