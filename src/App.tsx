/**
 * Assembles the application from the store and PWA hooks and the page components.
 * Shows shared notices and switches between shopping and order history.
 */
import { useCampusStore } from "./hooks/useCampusStore";
import { usePwa } from "./hooks/usePwa";
import { StoreHeader } from "./components/StoreHeader";
import { Storefront } from "./components/Storefront";
import { ShoppingBag } from "./components/ShoppingBag";
import { OrderHistory } from "./components/OrderHistory";
import { Bag } from "./components/BagIcon";
import { money } from "./lib/money";
import { formatOrderCooldown } from "./lib/orderCooldown";
import "./App.css";

export default function App() {
  const store = useCampusStore();
  const pwa = usePwa();
  const { view, online, locked, error, booting, notice, quantity, total, orderCooldownMs, nextOrderAt } =
    store;
  const { installHelp, setInstallHelp, update } = pwa;
  return (
    <>
      <div className="demo-strip">
        <span>DEMO EXPERIENCE</span> Sample menu, simulated funds & robot
        delivery. No real purchases.
      </div>
      <StoreHeader {...store} {...pwa} />
      <main>
        {installHelp && (
          <div className="message">
            On iPhone: open this page in Safari, tap Share, then Add to Home
            Screen. On Android or desktop: use your browser’s Install app
            option. Installation needs HTTPS or localhost.
            <button
              onClick={() => setInstallHelp(false)}
              aria-label="Dismiss installation instructions"
            >
              ×
            </button>
          </div>
        )}
        {!online && (
          <div className="message warning" role="status">
            You’re offline. Browse your saved inventory and bag. Stock may have changed.
            Reconnect to reserve or confirm items. Existing checkout timers continue offline.
          </div>
        )}
        {update && (
          <div className="message">
            A new version is ready. Your bag will be kept.
            <button
              disabled={locked}
              onClick={() =>
                update.waiting?.postMessage({ type: "SKIP_WAITING" })
              }
            >
              Update app
            </button>
          </div>
        )}
        {error && (
          <div className="message warning" role="alert">
            {error}
            <button onClick={() => void store.reconnect()} disabled={booting}>
              Reconnect
            </button>
          </div>
        )}
        {orderCooldownMs > 0 && nextOrderAt && (
          <div className="message warning" role="status" aria-live="polite">
            <strong>Order cooldown active.</strong> Multiple order requests were detected, so only one robot order is allowed per hour.
            {" "}Time remaining: <strong>{formatOrderCooldown(orderCooldownMs)}</strong>.
          </div>
        )}
        <div className={notice ? "message" : "sr-only"} role="status" aria-live="polite">
          {notice}
        </div>
        <div className="message" role="status">
          <div>
            {store.inventoryFetchedAt
              ? <>Catalog last fetched by this browser: {new Date(store.inventoryFetchedAt).toLocaleString()}.</>
              : "Sample menu only · no saved catalog response yet."}
            {" "}Catalog refreshes every 15 minutes while online. This is not the time stock last changed.
            {" "}Source stock-change and sync times are shown per item. Checkout always checks current stock.
            {store.inventoryUnavailable && " The latest refresh failed; showing your last saved snapshot."}
            {store.lastApiSuccessAt && <div>Last successful server contact: {new Date(store.lastApiSuccessAt).toLocaleString()}.</div>}
          </div>
        </div>
        {view === "shop" ? (
          <div className="shop-layout">
            <Storefront {...store} />
            <ShoppingBag {...store} />
          </div>
        ) : (
          <OrderHistory {...store} />
        )}
      </main>
      {view === "shop" && quantity > 0 && (
        <a className="mobile-bag" href="#bag">
          <span>
            <Bag size={20} /> View bag · {quantity}{" "}
            {quantity === 1 ? "item" : "items"}
          </span>
          <strong>{money(total)}</strong>
        </a>
      )}
      <footer>
        <span>campusstore</span>
        <p>Built for the space between classes.</p>
        <span>Prototype · Simulated integrations</span>
      </footer>
    </>
  );
}
