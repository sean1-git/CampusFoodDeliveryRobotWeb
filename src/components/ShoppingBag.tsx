/**
 * Displays bag quantities, estimated totals, and the delivery-location form.
 * Checkout calls the store hook; the server validates prices and demo funds.
 */
import { money } from "../lib/money";
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
  | "setCheckout"
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
  setCheckout,
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
      {quantity === 0 && !pending ? (
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
                value={pending?.body.location ?? location}
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
              <button
                className="primary"
                type="submit"
                disabled={!online || !session || submitting}
              >
                {submitting
                  ? "Confirming your order…"
                  : pending
                    ? "Retry this checkout"
                    : "Place demo order"}
              </button>
              {!locked && (
                <button
                  type="button"
                  className="back"
                  onClick={() => setCheckout(false)}
                >
                  Back to bag
                </button>
              )}
            </form>
          ) : (
            <button
              className="primary"
              disabled={!online || !session}
              onClick={() => setCheckout(true)}
            >
              Review demo order <span>→</span>
            </button>
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
