/**
 * Small self-contained Material Web-compatible interaction layer.
 *
 * The official @material/web package can replace these registrations when it
 * is available. These elements intentionally keep native light-DOM content
 * so React event handlers, CSS tokens, and the app's offline bundle continue
 * to work without a CDN dependency.
 */
class MaterialInteractiveElement extends HTMLElement {
  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (this.hasAttribute("disabled")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.click();
    }
  };

  private readonly handleClick = (event: MouseEvent) => {
    if (this.hasAttribute("disabled")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  connectedCallback() {
    this.setAttribute("role", this.getAttribute("role") || "button");
    if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "0");
    this.addEventListener("keydown", this.handleKeydown);
    this.addEventListener("click", this.handleClick);
  }

  disconnectedCallback() {
    this.removeEventListener("keydown", this.handleKeydown);
    this.removeEventListener("click", this.handleClick);
  }
}

if (!customElements.get("md-assist-chip")) {
  customElements.define("md-assist-chip", class extends MaterialInteractiveElement {});
}

if (!customElements.get("md-outlined-button")) {
  customElements.define("md-outlined-button", class extends MaterialInteractiveElement {});
}
