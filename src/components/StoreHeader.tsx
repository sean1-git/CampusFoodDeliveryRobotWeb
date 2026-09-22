/**
 * Displays navigation, active-order count, demo wallet balance, and installation control.
 * Receives data and actions from the hooks through App.tsx.
 */
import { money } from "../lib/money";
import type { CampusStore } from "../hooks/useCampusStore";
import { Bag } from "./BagIcon";
import type { PwaControls } from "../hooks/usePwa";

type Props = Pick<
  CampusStore,
  "view" | "setView" | "activeOrders" | "session"
> &
  Pick<PwaControls, "installed" | "install">;
export function StoreHeader({
  view,
  setView,
  activeOrders,
  session,
  installed,
  install,
}: Props) {
  return (
    <header className="header">
      <a
        className="brand"
        href="#"
        onClick={() => setView("shop")}
        aria-label="Campus Store home"
      >
        <span className="brand-mark">
          <Bag />
        </span>
        <span>
          campus<span className="brand-light">store</span>
          <small>YOUR CAMPUS, DELIVERED.</small>
        </span>
      </a>
      <nav aria-label="Main navigation">
        <button
          className={view === "shop" ? "nav-active" : ""}
          onClick={() => setView("shop")}
        >
          The store
        </button>
        <button
          className={view === "orders" ? "nav-active" : ""}
          onClick={() => setView("orders")}
        >
          My orders{" "}
          {activeOrders > 0 && <span className="count">{activeOrders}</span>}
        </button>
      </nav>
      <div className="header-actions">
        {!installed && (
          <button className="install" onClick={() => void install()}>
            ↧ <span>Install app</span>
          </button>
        )}
        <div className="wallet">
          <span>DEMO WALLET</span>
          <strong>{session ? money(session.balanceCents) : "—"}</strong>
        </div>
      </div>
    </header>
  );
}
