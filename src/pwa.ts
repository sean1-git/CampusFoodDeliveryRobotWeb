/**
 * Registers the generated service worker in production for cached offline browsing.
 * Notifies usePwa when an update is waiting and reloads after the user activates it.
 */
if (import.meta.env.PROD && import.meta.env.MODE !== "native" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        const notify = () =>
          window.dispatchEvent(
            new CustomEvent("campus-update", { detail: registration }),
          );
        if (registration.waiting) notify();
        registration.addEventListener("updatefound", () => {
          registration.installing?.addEventListener("statechange", () => {
            if (registration.waiting && navigator.serviceWorker.controller)
              notify();
          });
        });
      })
      .catch(() => {});
  });
  // First install can take control without downloading and rendering the page twice.
  let hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) { hadController = true; return; }
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}
