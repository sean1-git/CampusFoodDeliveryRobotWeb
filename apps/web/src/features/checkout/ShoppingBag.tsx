import { DeliveryProgress } from "../delivery/DeliveryProgress";
/**
 * Displays bag quantities, estimated totals, and the delivery-location form.
 * Checkout calls the store hook; the server validates prices and demo funds.
 */
import { money } from "../../shared/utils/money";
import { formatOrderCooldown } from "./orderCooldown";
import type { CampusStore } from "../../app/useCampusStore";
import { Bag } from "../../shared/ui/BagIcon";
import { storeName } from "../../../../../packages/domain/src/catalog/stores";

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
  | "destination"
  | "session"
  | "online"
  | "submitting"
  | "beginCheckout"
  | "cancelCheckout"
  | "reservation"
  | "secondsLeft"
  | "orderCooldownMs"
  | "nextOrderAt"
  | "setView"
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
  destination,
  session,
  online,
  submitting,
  beginCheckout,
  cancelCheckout,
  reservation,
  secondsLeft,
  orderCooldownMs,
  nextOrderAt,
  setView,
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
          <ol className="checkout-steps" aria-label="Checkout progress">
            <li className="complete"><span>✓</span>Bag</li>
            <li className={destination || reservation?.body.destination ? "complete" : "current"}><span>2</span>Delivery pin</li>
            <li className={checkout ? "current" : ""}><span>3</span>Confirm</li>
          </ol>
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
                  <small className="bag-pickup-store">{storeName(p.storeId)}</small>
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
              <p>{reservation?.body.location ?? pending?.body.location ?? location}</p>
              <p className="checkout-note">Confirmed pin: {(reservation?.body.destination ?? pending?.body.destination)?.lat.toFixed(6)}, {(reservation?.body.destination ?? pending?.body.destination)?.lng.toFixed(6)}</p>
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
                <DeliveryProgress value={secondsLeft / 300} label="Reservation time remaining" />
              )}
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
              <p className="field-label">Delivery location</p>
              <button type="button" className="back" onClick={() => setView("map")}>{destination ? "Change delivery pin →" : "Choose your delivery pin →"}</button>
              <p className="checkout-note">{destination ? <>Confirmed: {destination.lat.toFixed(6)}, {destination.lng.toFixed(6)}</> : "Choose and confirm a supported campus pin before we process your order."}</p>
              <p className="checkout-note">
                {orderCooldownMs > 0 && nextOrderAt
                  ? <>Your next order unlocks when this delivery arrives. Estimated wait: <strong>{formatOrderCooldown(orderCooldownMs)}</strong> · arrival around {new Date(nextOrderAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</>
                  : <>Enter checkout to hold your items for five minutes. Your wallet is charged only when you confirm.</>}
              </p>
              <button
              className="primary"
              disabled={!online || !session || submitting || orderCooldownMs > 0}
              onClick={() => void beginCheckout()}
            >
              {orderCooldownMs > 0 ? "Robot completing delivery" : !destination ? "Choose delivery pin →" : <>Reserve & review order <span>→</span></>}
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
