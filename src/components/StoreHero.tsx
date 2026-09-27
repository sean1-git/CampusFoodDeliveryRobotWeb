import { memo } from "react";
import type { CampusStore } from "../hooks/useCampusStore";
import { money } from "../lib/money";

// Keep the hero outside the menu/bag grid so both edges share the page gutters.
export const StoreHero = memo(function StoreHero({ catalog, storeId, setView }: Pick<CampusStore, "catalog" | "storeId" | "setView">) {
  return (
      <div className="intro" data-store={storeId}>
        <div>
          <p className="eyebrow"><span className="hero-spark" aria-hidden="true">✦</span> UC MERCED. YOUR CAMPUS.</p>
          <h1>
            Small cravings.
            <br />
            Big campus energy.
          </h1>
          <p>
            Fresh bites, study fuel, and little pick-me-ups.
            <br className="desktop-break" /> Pick your favorites. We’ll take it
            from here.
          </p>
          <div className="hero-actions"><md-filled-tonal-button onClick={() => document.getElementById("store-inventory")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })}>Explore the menu <span aria-hidden="true">↘</span></md-filled-tonal-button><button className="hero-map-link" onClick={() => setView("map")}>Choose a delivery pin ↗</button></div>
          <div className="hero-facts"><span>02 UC Merced stores</span><span>One bag. One delivery.</span></div>
        </div>
        <div className="delivery-note">
          <div className="robot-scene" aria-hidden="true">
            <span className="orbit orbit-one" /><span className="orbit orbit-two" />
            <span className="floating-snack snack-one">🥪</span><span className="floating-snack snack-two">☕</span>
            <img className="delivery-robot-hero" src="/delivery-robot.svg" alt="" />
          </div>
          <strong>Your little delivery buddy.</strong>
          <span>Robot delivery · simulated</span>
          <span className="fee">{money(catalog.deliveryFeeCents)} delivery</span>
        </div>
      </div>
  );
});
