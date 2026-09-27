import { lazy, Suspense } from "react";
/**
 * Assembles the application from the store and PWA hooks and the page components.
 * Shows shared notices and switches between shopping and order history.
 */
import { useCampusStore } from "./hooks/useCampusStore";
import { usePwa } from "./hooks/usePwa";
import { StoreHeader } from "./components/StoreHeader";
import { Storefront } from "./components/Storefront";
import { ShoppingBag } from "./components/ShoppingBag";
const OrderHistory = lazy(() => import("./components/OrderHistory").then(module => ({ default: module.OrderHistory })));
const DeliveryLocation = lazy(() => import("./components/DeliveryMap").then(module => ({ default: module.DeliveryLocation })));
import { Bag } from "./components/BagIcon";
import { money } from "./lib/money";
import { DeliveryStatus } from "./components/DeliveryStatus";
import { DeliveryCelebration } from "./components/DeliveryCelebration";
import "./App.css";
import "./MaterialEnhancements.css";

export default function App() {
  const store = useCampusStore();
  const pwa = usePwa();
  const { view, online, locked, error, booting, notice, quantity, total, orderCooldownMs, nextOrderAt } =
    store;
  const { installHelp, setInstallHelp, update } = pwa;
  return (
    <>
      <DeliveryCelebration orders={store.orders} />
      <div className="demo-strip">
        <span>DEMO EXPERIENCE</span> Sample menu, simulated funds & robot
        delivery. No login or real purchases. Each browser gets a demo wallet.
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
        {error && view !== "map" && (
          <div className="message warning" role="alert">
            {error}
            <button onClick={() => void store.reconnect()} disabled={booting}>
              Reconnect
            </button>
          </div>
        )}
        {orderCooldownMs > 0 && nextOrderAt && <DeliveryStatus {...store} />}
        <div className={notice ? "message" : "sr-only"} role="status" aria-live="polite">
          {notice}
        </div>
        {view !== "map" && <details className="inventory-disclosure">
          <summary><span className={`connection-dot${online ? "" : " offline"}`} />{online ? "Online browsing" : "Offline browsing"} <span>Inventory & sync details</span></summary>
          <div>
            {store.inventoryFetchedAt
              ? <>Catalog last fetched by this browser: {new Date(store.inventoryFetchedAt).toLocaleString()}.</>
              : "Sample menu only · no saved catalog response yet."}
            {" "}Catalog refreshes every 15 minutes while online. This is not the time stock last changed.
            {" "}Source stock-change and sync times are shown per item. Checkout always checks current stock.
            {store.inventoryUnavailable && " The latest refresh failed; showing your last saved snapshot."}
            {store.lastApiSuccessAt && <div>Last successful server contact: {new Date(store.lastApiSuccessAt).toLocaleString()}.</div>}
          </div>
        </details>}
        <Suspense fallback={<p role="status">Loading your campus view…</p>}>
        {view === "map" ? (
          <DeliveryLocation {...store} destination={store.reservation?.body.destination ?? store.pending?.body.destination ?? store.destination} />
        ) : view === "shop" ? (
          <div className="shop-layout">
            <Storefront {...store} />
            <ShoppingBag {...store} />
          </div>
        ) : (
          <OrderHistory {...store} />
        )}
        </Suspense>
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
        <div className="ucm-footer-brand"><img src="/uc-merced-seal.png" alt="University of California, Merced seal" width="64" height="64" /><div><strong>University of California, Merced</strong><p>Campus Store · Built for the space between classes.</p></div></div>
        <span>Prototype · Simulated integrations</span>
      </footer>
    </>
  );
}
