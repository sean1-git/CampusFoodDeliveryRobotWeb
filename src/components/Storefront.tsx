/**
 * Displays the sample menu and category filters.
 * Add buttons call the store hook to update bag quantities.
 */
import { money } from "../lib/money";
import { inventoryFreshnessLabel } from "../lib/inventoryFreshness";
import type { CampusStore } from "../hooks/useCampusStore";

type Props = Pick<
  CampusStore,
  "catalog" | "filter" | "setFilter" | "cart" | "locked" | "change"
>;
export function Storefront({
  catalog,
  filter,
  setFilter,
  cart,
  locked,
  change,
}: Props) {
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
      <div className="section-heading">
        <h2>What sounds good?</h2>
        <span>{catalog.products.length} sample favorites</span>
      </div>
      <div className="filters" aria-label="Product categories">
        {["All items", "Lunch", "Drinks", "Snacks"].map((label) => (
          <md-assist-chip
            key={label}
            aria-pressed={filter === label ? "true" : undefined}
            className={filter === label ? "selected" : ""}
            onClick={() => setFilter(label)}
          >
            {label}
          </md-assist-chip>
        ))}
      </div>
      <div className="products">
        {catalog.products
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
                <p>Demo pickup: {p.storeId === "library" ? "Kolligian Library store" : "The Summits Marketplace"}</p>
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
      <p className="menu-note">
        A sample menu for exploring the experience. Product details and
        availability are illustrative. Stock is shared by all demo visitors and
        confirmed at checkout; adding to your bag does not reserve an item.
      </p>
    </section>
  );
}
