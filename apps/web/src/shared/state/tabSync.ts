/**
 * Small same-origin tab bus. BroadcastChannel is immediate; localStorage is
 * the fallback for browsers that do not implement it. Payloads contain only
 * an event name, so session data never travels through the tab bus.
 */
export type TabEvent = "cart" | "checkout" | "session" | "orders";

const CHANNEL_NAME = "campus-store-tabs";
const STORAGE_KEY = "campus-store-tab-event";
const sender = crypto.randomUUID();
let channel: BroadcastChannel | null = null;

function getChannel() {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  try { channel = new BroadcastChannel(CHANNEL_NAME); } catch { /* Use storage fallback. */ }
  return channel;
}

export function publishTabEvent(type: TabEvent) {
  const message = { type, sender, id: crypto.randomUUID() };
  try { getChannel()?.postMessage(message); } catch { /* Use storage fallback. */ }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
  } catch {
    /* Tab synchronization is an enhancement; server state remains authoritative. */
  }
}

export function subscribeTabEvents(listener: (type: TabEvent) => void) {
  const seen = new Set<string>();
  const onMessage = (event: MessageEvent) => {
    const message = event.data;
    if (!message || message.sender === sender || typeof message.sender !== "string"
      || typeof message.id !== "string"
      || !["cart", "checkout", "session", "orders"].includes(message.type)
      || seen.has(message.id)) return;
    seen.add(message.id);
    if (seen.size > 256) seen.delete(seen.values().next().value!);
    listener(message.type);
  };
  const current = getChannel();
  current?.addEventListener("message", onMessage);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      onMessage(new MessageEvent("message", { data: JSON.parse(event.newValue) }));
    } catch {
      /* Ignore malformed local storage events. */
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    current?.removeEventListener("message", onMessage);
    window.removeEventListener("storage", onStorage);
  };
}
