/**
 * Displays the sample menu and category filters.
 * Add buttons call the store hook to update bag quantities.
 */
import { money } from "../lib/money";
import { inventoryFreshnessLabel } from "../lib/inventoryFreshness";
import type { CampusStore } from "../hooks/useCampusStore";
import { stores, storeName } from "../../shared/stores";

type Props = Pick<
  CampusStore,
  "catalog" | "filter" | "setFilter" | "cart" | "locked" | "change" | "storeId" | "setStoreId"
>;
export function Storefront({
  catalog,
  filter,
  setFilter,
  cart,
  locked,
  change,
  storeId,
  setStoreId,
}: Props) {
  const selectedStore = stores.find(store => store.id === storeId)!;
  const storeProducts = catalog.products.filter(product => product.storeId === storeId);
  function selectStore(id: string) { setStoreId(id); setFilter("All items"); }
  return (
    <section className="storefront">
      <div className="intro">
        <div>
          <p className="eyebrow">THE CAMPUS EDIT</p>
          <h1>
            A good day starts
            <br />
            with a full bag.
          </h1>
          <p>
            Fresh bites, study fuel, and little pick-me-ups.
            <br className="desktop-break" /> Pick your favorites. We’ll take it
            from here.
          </p>
        </div>
        <div className="delivery-note">
          <span className="robot-icon" aria-hidden="true">
            ▣
          </span>
          <strong>
            Meet your
            <br />
            delivery buddy.
          </strong>
          <span>Robot delivery · demo</span>
          <span className="availability-note">
            Explore the campus map to preview a simulated delivery route.
          </span>
          <span className="fee">
            {money(catalog.deliveryFeeCents)} delivery
          </span>
        </div>
      </div>
      <div className="store-tabs" role="tablist" aria-label="Campus stores">
        {stores.map((store, index) => <button key={store.id} role="tab" id={`store-tab-${store.id}`}
          aria-selected={storeId === store.id} aria-controls="store-inventory" tabIndex={storeId === store.id ? 0 : -1}
          onClick={() => selectStore(store.id)} onKeyDown={event => {
            const next = event.key === "Home" ? 0 : event.key === "End" ? stores.length - 1
              : event.key === "ArrowRight" ? (index + 1) % stores.length : event.key === "ArrowLeft" ? (index + stores.length - 1) % stores.length : -1;
            if (next < 0) return; event.preventDefault(); selectStore(stores[next].id);
            document.getElementById(`store-tab-${stores[next].id}`)?.focus();
          }}>
          <span className="store-tab-icon" aria-hidden="true">{store.icon}</span>
          <span>{store.name}<small>{catalog.products.filter(p => p.storeId === store.id).length} simulated items</small></span>
        </button>)}
      </div>
      <div id="store-inventory" role="tabpanel" aria-labelledby={`store-tab-${storeId}`}>
      <div className="section-heading">
        <div><h2>{selectedStore.name}</h2><p className="store-description">{selectedStore.description}</p></div>
        <span className="demo-inventory-badge">Simulated inventory</span>
      </div>
      <p className="store-inventory-note">Sample food and prices for testing. The school inventory API is not connected yet. You can mix items from both stores in one bag.</p>
      <div className="filters" aria-label="Product categories">
        {["All items", "Lunch", "Drinks", "Snacks"].map((label) => (
          <md-filter-chip
            key={label}
            selected={filter === label}
              label={label}
            className={filter === label ? "selected" : ""}
            onClick={() => setFilter(label)}
          >
            {label}
          </md-filter-chip>
        ))}
      </div>
      <div className="products">
        {storeProducts
          .filter((p) => filter === "All items" || p.category === filter)
          .map((p) => (
            <article className="product" key={p.id}>
              <div className="product-art" style={{ backgroundColor: p.color }}>
                <span className="product-tag">{p.tag}</span>
                <span className="food" role="img" aria-label={p.name}>
                  {p.emoji}
                </span>
                <span className="art-label">CAMPUS FAVORITES</span>
              </div>
              <div className="product-details">
                <div className="product-category">{p.category}</div>
                <h3>{p.name}</h3>
                <p>{p.description}</p>
                <p className="pickup-chip">Pickup: {storeName(p.storeId)}</p>
                <p>{p.stock === undefined ? "Connect to check stock" : p.stock === 0 ? "Sold out" : `${p.stock} left in demo stock`}</p>
                <p>{inventoryFreshnessLabel(p)}</p>
                <div className="product-bottom">
                  <strong>{money(p.priceCents)}</strong>
                  <button
                    disabled={locked || (cart[p.id] || 0) >= Math.min(20, p.stock ?? 20)}
                    className="add"
                    onClick={() => change(p, 1)}
                    aria-label={`Add ${p.name} to bag`}
                  >
                    {p.stock === 0 ? "Sold out" : cart[p.id] > 0 ? `${cart[p.id]} in bag · +` : "Add +"}
                  </button>
                </div>
              </div>
            </article>
          ))}
      </div>
      </div>
      <p className="menu-note">
        A sample menu for exploring the experience. Product details and
        availability are illustrative. Stock is shared by all demo visitors and
        confirmed at checkout; adding to your bag does not reserve an item.
      </p>
    </section>
  );
}
