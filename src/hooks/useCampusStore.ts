import { useCallback, useEffect, useRef, useState } from "react";
import sampleCatalog from "../../shared/catalog.json";
import type { Cart, HeldCheckout, Order, Pending, Product, QueuedCheckout, Reservation, Session } from "../types";
import { requestJson } from "../lib/api";
import { initialCart, load, save } from "../lib/storage";
import { readReservation, reservationExpired, RESERVATION_KEY } from "../lib/inventoryCache";
import { useInventory } from "./useInventory";

type CheckoutReply = Order | HeldCheckout | QueuedCheckout;
type ApiError = Error & { status?: number; code?: string };
const restoreHold = () => { try { return readReservation(localStorage); } catch { return null; } };

export function useCampusStore() {
  const [online, setOnline] = useState(navigator.onLine);
  const inventory = useInventory(online);
  const { catalog, refreshInventory } = inventory;
  const [session, setSession] = useState<Session | null>(null);
  const [cart, setCart] = useState<Cart>(initialCart);
  const [orders, setOrders] = useState<Order[]>([]);
  const [view, setView] = useState<"shop" | "orders">("shop");
  const [filter, setFilter] = useState("All items");
  const [location, setLocation] = useState(sampleCatalog.locations[0]);
  const [reservation, setReservation] = useState<Reservation | null>(restoreHold);
  const reservationRef = useRef(reservation);
  // Retain unfinished checkouts from the prior app version for safe recovery.
  const [pending, setPending] = useState<Pending | null>(() => load("campus-pending", null));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const [booting, setBooting] = useState(true);
  const [clock, setClock] = useState(Date.now());
  const [lastApiSuccessAt, setLastApiSuccessAt] = useState<number | null>(() => {
    try { return Number(localStorage.getItem("campus-last-api-success")) || null; } catch { return null; }
  });

  const writeHold = useCallback((next: Reservation | null) => {
    save(RESERVATION_KEY, next);
    reservationRef.current = next;
    setReservation(next);
  }, []);
  const clearExpired = useCallback(() => {
    writeHold(null);
    save("campus-cart", {});
    setCart({});
    setNotice("Your checkout expired. All items were removed and released. No demo funds were charged.");
    void refreshInventory(true).catch(() => {});
  }, [writeHold, refreshInventory]);

  const refresh = useCallback(async () => {
    const user = await requestJson<Session>("/api/session");
    setSession(user);
    const data = await requestJson<{ orders: Order[] }>("/api/orders");
    setOrders(data.orders);
  }, []);
  const finishOrder = useCallback((order: Order) => {
    writeHold(null);
    save("campus-pending", null);
    setPending(null);
    save("campus-cart", {});
    setCart({});
    setView("orders");
    setOrders((old) => [order, ...old.filter((o) => o.id !== order.id)]);
    setNotice("Demo order placed. No real money was charged and no robot was dispatched.");
    void refresh().catch(() => {});
    void refreshInventory(true).catch(() => {});
  }, [writeHold, refresh, refreshInventory]);

  const acceptReply = useCallback((result: CheckoutReply, attempt: Reservation) => {
    if (result.status === "pending") return;
    if (result.status === "held") {
      writeHold({ ...attempt, phase: attempt.phase === "confirming" || attempt.phase === "cancelling" ? attempt.phase : "held", expiresAt: result.expiresAt,
        clockOffsetMs: result.serverNow - Date.now() });
      setCart(Object.fromEntries(attempt.body.items.map((p) => [p.id, p.quantity])));
      setNotice("Your items are reserved for five minutes. Confirm before the timer ends.");
    } else finishOrder(result);
  }, [writeHold, finishOrder]);

  const reconcileHold = useCallback(async () => {
    const attempt = reservationRef.current;
    if (!attempt || busy.current) return;
    try {
      const result = await requestJson<CheckoutReply>(`/api/checkouts/${attempt.key}`);
      if (reservationRef.current?.key !== attempt.key || busy.current) return;
      acceptReply(result, attempt);
    } catch (failure) {
      const problem = failure as ApiError;
      if (reservationRef.current?.key !== attempt.key || busy.current) return;
      if (problem.code === "expired") clearExpired();
      else if (problem.status === 410 || problem.status === 404 || problem.code === "sold_out" || problem.code === "insufficient_funds") {
        writeHold(null);
        setError(problem.message);
      }
      // A transport failure cannot prove that a confirmation failed.
    }
  }, [acceptReply, clearExpired, writeHold]);

  useEffect(() => { save("campus-cart", cart); }, [cart]);
  useEffect(() => {
    const apiSuccess = (event: Event) => setLastApiSuccessAt((event as CustomEvent<number>).detail);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("campus-api-success", apiSuccess);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("campus-api-success", apiSuccess);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (!online) { setBooting(false); return; }
    let active = true;
    setBooting(true);
    void refresh().then(() => { if (active) { setError(""); void reconcileHold(); } })
      .catch(() => { if (active) setError("The server is unavailable. Your saved inventory and bag remain available offline."); })
      .finally(() => { if (active) setBooting(false); });
    return () => { active = false; };
  }, [online, refresh, reconcileHold]);

  const activeOrders = orders.filter((o) => o.status !== "delivered").length;
  const csrf = session?.csrf;
  const hasCheckout = !!reservation || !!pending;
  useEffect(() => {
    if (!online || !csrf || (!activeOrders && !hasCheckout)) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
      void reconcileHold();
    }, 5000);
    return () => clearInterval(timer);
  }, [online, csrf, activeOrders, hasCheckout, refresh, reconcileHold]);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      setClock(now);
      const held = reservationRef.current;
      if (held && !busy.current && reservationExpired(held, now)) clearExpired();
    };
    tick();
    const timer = setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [clearExpired]);

  const lines = catalog.products.filter((p) => cart[p.id] > 0);
  const quantity = lines.reduce((sum, p) => sum + cart[p.id], 0);
  const subtotal = lines.reduce((sum, p) => sum + p.priceCents * cart[p.id], 0);
  const total = subtotal + (quantity ? catalog.deliveryFeeCents : 0);
  const locked = submitting || !!pending || !!reservation;
  const checkout = hasCheckout;
  const secondsLeft = reservation ? Math.min(300, Math.max(0, Math.ceil((reservation.expiresAt - clock - reservation.clockOffsetMs) / 1000))) : 0;

  function change(product: Product, amount: number) {
    if (locked) return;
    setCart((old) => ({ ...old, [product.id]: amount > 0
      ? Math.max(old[product.id] || 0, Math.min(20, product.stock ?? 20, (old[product.id] || 0) + amount))
      : Math.max(0, (old[product.id] || 0) + amount) }));
    setNotice(amount > 0 ? `${product.name} added to your bag.` : `${product.name} quantity updated.`);
  }
  const headers = (key: string) => ({ "Content-Type": "application/json", "X-CSRF-Token": session!.csrf, "Idempotency-Key": key });
  async function waitForReply(result: CheckoutReply, key: string, confirm = false): Promise<CheckoutReply> {
    const deadline = Date.now() + 15000;
    while (result.status === "pending") {
      if (Date.now() >= deadline) throw new Error("Checkout is still queued.");
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = confirm
        ? await requestJson<CheckoutReply>(`/api/reservations/${key}/confirm`, { method: "POST", headers: headers(key) })
        : await requestJson<CheckoutReply>(`/api/checkouts/${key}`);
    }
    return result;
  }
  function failAction(failure: unknown) {
    const problem = failure as ApiError;
    if (problem.code === "expired") clearExpired();
    else if (problem.status && [400, 404, 409, 410].includes(problem.status)) {
      writeHold(null);
      save("campus-pending", null);
      setPending(null);
    }
    setError(problem.status ? problem.message : "Connection interrupted. Your checkout ID is saved. Reconnect and retry to check its outcome safely.");
    void refreshInventory(true).catch(() => {});
  }
  async function beginCheckout() {
    if (!online || !session || busy.current || pending || !quantity) return;
    busy.current = true;
    setSubmitting(true);
    setError("");
    const attempt: Reservation = reservationRef.current ?? {
      key: crypto.randomUUID(), body: { items: lines.map((p) => ({ id: p.id, quantity: cart[p.id] })), location },
      phase: "reserving", expiresAt: Date.now() + 300000, clockOffsetMs: 0,
    };
    writeHold(attempt);
    try {
      const result = await requestJson<CheckoutReply>("/api/reservations", {
        method: "POST", headers: headers(attempt.key), body: JSON.stringify(attempt.body),
      });
      acceptReply(await waitForReply(result, attempt.key), attempt);
      void refreshInventory(true).catch(() => {});
    } catch (failure) { failAction(failure); }
    finally { busy.current = false; setSubmitting(false); }
  }
  async function placeOrder() {
    if (!online || !session || busy.current) return;
    const attempt = reservationRef.current;
    if (attempt?.phase === "reserving") { await beginCheckout(); return; }
    if (!attempt && !pending) return;
    if (attempt && reservationExpired(attempt, Date.now())) { clearExpired(); return; }
    busy.current = true;
    setSubmitting(true);
    setError("");
    try {
      if (pending && !attempt) {
        const result = await requestJson<CheckoutReply>("/api/orders", {
          method: "POST", headers: headers(pending.key), body: JSON.stringify(pending.body),
        });
        const final = await waitForReply(result, pending.key);
        if (final.status !== "held" && final.status !== "pending") finishOrder(final);
      } else if (attempt) {
        writeHold({ ...attempt, phase: "confirming" });
        const result = await requestJson<CheckoutReply>(`/api/reservations/${attempt.key}/confirm`, {
          method: "POST", headers: headers(attempt.key),
        });
        acceptReply(await waitForReply(result, attempt.key, true), { ...attempt, phase: "confirming" });
      }
    } catch (failure) { failAction(failure); }
    finally { busy.current = false; setSubmitting(false); }
  }
  async function cancelCheckout() {
    const attempt = reservationRef.current;
    if (!attempt || !online || !session || busy.current || attempt.phase === "confirming") return;
    busy.current = true;
    setSubmitting(true);
    writeHold({ ...attempt, phase: "cancelling" });
    try {
      const result = await requestJson<Order | { status: "cancelled" }>(`/api/reservations/${attempt.key}/cancel`, {
        method: "POST", headers: headers(attempt.key),
      });
      if (result.status === "cancelled") {
        writeHold(null);
        setNotice("Reservation cancelled. Your items were released; your bag is kept for editing.");
        void refreshInventory(true).catch(() => {});
      } else finishOrder(result);
    } catch (failure) { failAction(failure); }
    finally { busy.current = false; setSubmitting(false); }
  }
  async function reconnect() {
    if (!navigator.onLine) { setOnline(false); return; }
    setOnline(true);
    setBooting(true);
    try { await refresh(); await refreshInventory(true); await reconcileHold(); setError(""); }
    catch { setError("Still unable to reach the server. Saved inventory remains available."); }
    finally { setBooting(false); }
  }

  return { ...inventory, session, cart, orders, view, setView, filter, setFilter, location, setLocation,
    checkout, online, error, notice, submitting, pending, reservation, secondsLeft, lastApiSuccessAt,
    booting, lines, quantity, subtotal, total, locked, activeOrders, change, beginCheckout, placeOrder,
    cancelCheckout, reconnect };
}
export type CampusStore = ReturnType<typeof useCampusStore>;
