import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import sampleCatalog from "../../../../packages/domain/src/catalog/catalog.json";
import type { Cart, HeldCheckout, Order, Pending, Product, QueuedCheckout, Reservation, Session } from "../shared/types";
import { requestJson } from "../shared/api/api";
import { checkoutRetryDelay } from "../shared/api/readGate";
import { initialCart, load, save } from "../shared/state/storage";
import { readReservation, reservationExpired, RESERVATION_KEY } from "../shared/state/inventoryCache";
import { publishTabEvent, subscribeTabEvents } from "../shared/state/tabSync";
import { createRefreshQueue } from "../shared/state/refreshQueue";
import { createOrderUpdates } from "../features/orders/orderUpdates";
import { sameCartQuantities, summarizeCart } from "../features/checkout/cart";
import { useInventory } from "../features/storefront/useInventory";
import { coordinate } from "../../../../packages/domain/src/delivery/deliveryRoute";
import type { DeliveryPin } from "../../../../packages/domain/src/campus/campusGeo";

type CheckoutReply = Order | HeldCheckout | QueuedCheckout;
type ApiError = Error & { status?: number; code?: string };
const restoreHold = () => { try { return readReservation(localStorage); } catch { return null; } };
// Older persisted checkouts still require this fallback label. New order labels
// are computed by the server from the confirmed delivery pin.
const location = sampleCatalog.locations[0];

export function useCampusStore() {
  const [online, setOnline] = useState(navigator.onLine);
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  const inventory = useInventory(online);
  const { catalog, refreshInventory, invalidateInventory } = inventory;
  const [session, setSession] = useState<Session | null>(null);
  const sessionToken = useRef<string | null>(null);
  const accountEpoch = useRef(0);
  const orderUpdates = useRef<ReturnType<typeof createOrderUpdates> | null>(null);
  const [cart, setCart] = useState<Cart>(initialCart);
  const [orders, setOrders] = useState<Order[]>([]);
  const [view, setView] = useState<"shop" | "orders" | "map">("shop");
  const [filter, setFilter] = useState("All items");
  const [storeId, setStoreId] = useState("summits");
  const [destination, setDestination] = useState<DeliveryPin | null>(null);
  const [reservation, setReservation] = useState<Reservation | null>(restoreHold);
  const reservationRef = useRef(reservation);
  const reconciliation = useRef<{ epoch: number; key: string; task: Promise<void> } | null>(null);
  const deferredRefresh = useRef(false);
  // Retain unfinished checkouts from the prior app version for safe recovery.
  const [pending, setPending] = useState<Pending | null>(() => load("campus-pending", null));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const [booting, setBooting] = useState(true);
  const [clock, setClock] = useState(() => Date.now());
  const [serverClockOffset, setServerClockOffset] = useState(0);
  const [lastApiSuccessAt, setLastApiSuccessAt] = useState<number | null>(() => {
    try { return Number(localStorage.getItem("campus-last-api-success")) || null; } catch { return null; }
  });

  const writeHold = useCallback((next: Reservation | null, broadcast = true) => {
    if (JSON.stringify(reservationRef.current) === JSON.stringify(next)) return;
    save(RESERVATION_KEY, next);
    reservationRef.current = next;
    setReservation(next);
    if (broadcast) publishTabEvent("checkout");
  }, []);
  const clearExpired = useCallback(() => {
    writeHold(null);
    save("campus-cart", {});
    setCart({});
    setNotice("Your checkout expired. All items were removed and released. No demo funds were charged.");
    void refreshInventory(true).catch(() => {});
  }, [writeHold, refreshInventory]);

  const readSession = useCallback(async () => {
      const epoch = accountEpoch.current;
      try {
        const user = await requestJson<Session & { orders: Order[] }>("/api/session?include=orders");
        // An expiry event invalidates any snapshot already in flight.
        if (epoch !== accountEpoch.current) return;
        const replaced = sessionToken.current !== null && sessionToken.current !== user.csrf;
        const receivedAt = Date.now();
        if (replaced) { accountEpoch.current++; orderUpdates.current?.resetSession(); }
        sessionToken.current = user.csrf;
        setSession(user);
        setServerClockOffset(user.serverNow ? user.serverNow - receivedAt : 0);
        setClock(receivedAt);
        if (replaced) {
          setOrders([]);
          publishTabEvent("session");
        }
        setOrders(user.orders.map((order) => ({ ...order, receivedAt })));
      } catch (failure) {
        const problem = failure as ApiError;
        if (epoch !== accountEpoch.current) return;
        if (problem.status === 401) {
          // An expired/revoked login must not leave another student's wallet
          // or order history visible. Do not rebroadcast repeated 401 polls.
          accountEpoch.current++;
          setSession(null);
          setOrders([]);
          setError(problem.message);
          orderUpdates.current?.resetSession();
          if (sessionToken.current !== null) publishTabEvent("session");
          sessionToken.current = null;
        }
        throw failure;
      }
  }, []);
  const refreshQueue = useRef<ReturnType<typeof createRefreshQueue> | null>(null);
  const refresh = useCallback((invalidate = true) => {
    refreshQueue.current ??= createRefreshQueue(readSession);
    return refreshQueue.current(invalidate);
  }, [readSession]);
  const expireSession = useCallback(() => {
    accountEpoch.current++;
    orderUpdates.current?.resetSession();
    sessionToken.current = null;
    setSession(null);
    setOrders([]);
    setServerClockOffset(0);
    publishTabEvent("session");
  }, []);
  const finishOrder = useCallback((order: Order) => {
    writeHold(null);
    save("campus-pending", null);
    setPending(null);
    save("campus-cart", {});
    setCart({});
    setView("orders");
    setOrders((old) => [{ ...order, receivedAt: Date.now() }, ...old.filter((o) => o.id !== order.id)]);
    setNotice("Demo order placed. No real money was charged and no robot was dispatched.");
    publishTabEvent("orders");
    void refresh().catch(() => {});
    void refreshInventory(true).catch(() => {});
  }, [writeHold, refresh, refreshInventory]);

  const acceptReply = useCallback((result: CheckoutReply, attempt: Reservation, broadcast = true) => {
    if (result.status === "pending") return;
    if (result.status === "held") {
      writeHold({ ...attempt, phase: attempt.phase === "confirming" || attempt.phase === "cancelling" ? attempt.phase : "held", expiresAt: result.expiresAt,
        clockOffsetMs: result.serverNow - Date.now() }, broadcast);
      const heldCart = Object.fromEntries(attempt.body.items.map((p) => [p.id, p.quantity]));
      setCart(current => sameCartQuantities(current, heldCart) ? current : heldCart);
      setNotice("Your items are reserved for five minutes. Confirm before the timer ends.");
    } else finishOrder(result);
  }, [writeHold, finishOrder]);

  const reconcileHold = useCallback(async () => {
    const attempt = reservationRef.current;
    if (!attempt || busy.current || !navigator.onLine || document.visibilityState === "hidden") return;
    const epoch = accountEpoch.current;
    const previous = reconciliation.current;
    if (previous?.epoch === epoch && previous.key === attempt.key) return previous.task;
    // Focus, tab events and the recovery timer can all request this same read.
    const task = (async () => {
      try {
        const result = await requestJson<CheckoutReply>(`/api/checkouts/${attempt.key}`);
        if (epoch !== accountEpoch.current || reservationRef.current?.key !== attempt.key || busy.current) return;
        acceptReply(result, attempt, false);
      } catch (failure) {
        const problem = failure as ApiError;
        if (epoch !== accountEpoch.current || reservationRef.current?.key !== attempt.key || busy.current) return;
        if (problem.code === "expired") clearExpired();
        else if (problem.status === 410 || problem.status === 404 || problem.code === "sold_out" || problem.code === "insufficient_funds") {
          writeHold(null);
          setError(problem.message);
        }
        // A transport failure cannot prove that a confirmation failed.
      }
    })().finally(() => { if (reconciliation.current?.task === task) reconciliation.current = null; });
    reconciliation.current = { epoch, key: attempt.key, task };
    return task;
  }, [acceptReply, clearExpired, writeHold]);

  const cartSnapshot = useRef(JSON.stringify(cart));
  useEffect(() => {
    const next = JSON.stringify(cart);
    if (next === cartSnapshot.current) return;
    cartSnapshot.current = next;
    save("campus-cart", cart);
    publishTabEvent("cart");
  }, [cart]);
  useEffect(() => {
    const apiSuccess = (event: Event) => setLastApiSuccessAt((event as CustomEvent<number>).detail);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    window.addEventListener("campus-api-success", apiSuccess);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("campus-api-success", apiSuccess);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const syncStoredState = useCallback(() => {
      const nextCart = initialCart();
      // Remote hydration must not publish the same cart back to every tab.
      cartSnapshot.current = JSON.stringify(nextCart);
      setCart((current) => sameCartQuantities(current, nextCart) ? current : nextCart);
      const nextHold = restoreHold();
      if (JSON.stringify(reservationRef.current) !== JSON.stringify(nextHold)) {
        reservationRef.current = nextHold;
        setReservation(nextHold);
      }
      setPending(load("campus-pending", null));
  }, []);

  useEffect(() => subscribeTabEvents((type) => {
    if (["cart", "checkout", "orders", "session"].includes(type)) syncStoredState();
    if (type === "session" || type === "orders") {
      // Preserve invalidations while hidden/offline even when the cached catalog is fresh.
      deferredRefresh.current = true;
      invalidateInventory();
      if (type === "orders") setNotice("An order was updated in another tab. Refreshing your wallet and order status.");
    }
    if (!navigator.onLine || document.visibilityState === "hidden") return;
    if (type === "checkout") {
      // The reserving broadcast precedes the POST; polling it now can return
      // 404 and erase another tab's in-flight checkout.
      if (reservationRef.current?.phase !== "reserving") void reconcileHold();
    }
    if (type === "session" || type === "orders") {
      deferredRefresh.current = false;
      void refresh().catch(() => { deferredRefresh.current = true; });
      void refreshInventory().catch(() => {});
    }
  }), [reconcileHold, refresh, refreshInventory, invalidateInventory, syncStoredState]);

  useEffect(() => {
    const wake = () => {
      if (!navigator.onLine || document.visibilityState === "hidden") return;
      syncStoredState();
      const invalidate = deferredRefresh.current;
      deferredRefresh.current = false;
      void refresh(invalidate).catch(() => { if (invalidate) deferredRefresh.current = true; });
      void refreshInventory().catch(() => {});
      void reconcileHold();
    };
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh, refreshInventory, reconcileHold, syncStoredState]);

  useEffect(() => {
    if (!online) { setBooting(false); return; }
    let active = true;
    setBooting(true);
    void refresh(false).then(() => { if (active) { setError(""); void reconcileHold(); } })
      .catch((failure: ApiError) => { if (active) setError(failure.status === 401 || failure.status === 429 ? failure.message
        : "The server is unavailable. Your saved inventory and bag remain available offline."); })
      .finally(() => { if (active) setBooting(false); });
    return () => { active = false; };
  }, [online, refresh, reconcileHold]);

  const activeOrders = useMemo(() => orders.filter((order) => order.status !== "delivered").length, [orders]);
  const csrf = session?.csrf;
  const hasCheckout = !!reservation || !!pending;
  const orderCooldownMs = session?.nextOrderAt
    ? Math.max(0, session.nextOrderAt - clock - serverClockOffset)
    : 0;
  const secondsLeft = reservation ? Math.min(300, Math.max(0, Math.ceil((reservation.expiresAt - clock - reservation.clockOffsetMs) / 1000))) : 0;
  useEffect(() => {
    const updates = createOrderUpdates({
      // Browser EventSource cannot authenticate with CapacitorHttp's cookie jar.
      connect: import.meta.env.MODE !== "native" && typeof EventSource !== "undefined"
        ? () => new EventSource("/api/events") : undefined,
      refresh,
      reconcileCheckout: () => { void reconcileHold(); },
      sessionExpired: expireSession,
    });
    orderUpdates.current = updates;
    return () => { updates.stop(); orderUpdates.current = null; };
  }, [refresh, reconcileHold, expireSession]);
  useEffect(() => {
    orderUpdates.current?.update({ sessionKey: csrf ?? null, online, visible,
      activeOrders: activeOrders > 0, checkout: hasCheckout });
  }, [csrf, online, visible, activeOrders, hasCheckout, refresh, reconcileHold, expireSession]);

  // Stream invalidations reconcile orders; checkout recovery keeps its own timer.
  // Elapsed estimates no longer need per-second renders.
  const needsCountdown = orderCooldownMs > 0
    || (!!reservation && (reservation.phase !== "confirming" || secondsLeft > 0));
  useEffect(() => {
    // Idle browsing has no countdown: avoid re-rendering the whole app every second.
    if (!needsCountdown) return;
    const tick = () => {
      const now = Date.now();
      if (document.visibilityState !== "hidden") setClock(now);
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
  }, [clearExpired, needsCountdown]);

  const { lines, quantity, subtotal, total } = useMemo(
    () => summarizeCart(catalog.products, cart, catalog.deliveryFeeCents),
    [catalog.products, catalog.deliveryFeeCents, cart],
  );
  const locked = submitting || hasCheckout;

  const change = useCallback((product: Product, amount: number) => {
    if (locked) return;
    setCart((old) => ({ ...old, [product.id]: amount > 0
      ? Math.max(old[product.id] || 0, Math.min(20, product.stock ?? 20, (old[product.id] || 0) + amount))
      : Math.max(0, (old[product.id] || 0) + amount) }));
    setNotice(amount > 0 ? `${product.name} added to your bag.` : `${product.name} quantity updated.`);
  }, [locked]);
  const headers = (key: string) => ({ "Content-Type": "application/json", "X-CSRF-Token": session!.csrf, "Idempotency-Key": key });
  async function waitForReply(result: CheckoutReply, key: string, confirm: boolean, epoch: number): Promise<CheckoutReply> {
    const deadline = Date.now() + 15000;
    let attempt = 0;
    while (result.status === "pending") {
      if (Date.now() >= deadline) throw new Error("Checkout is still queued.");
      await new Promise((resolve) => setTimeout(resolve, checkoutRetryDelay(attempt++)));
      if (!navigator.onLine || document.visibilityState === "hidden" || Date.now() >= deadline) return result;
      if (epoch !== accountEpoch.current) return result;
      result = confirm
        ? await requestJson<CheckoutReply>(`/api/reservations/${key}/confirm`, { method: "POST", headers: headers(key) })
        : await requestJson<CheckoutReply>(`/api/checkouts/${key}`);
    }
    return result;
  }
  function failAction(failure: unknown) {
    const problem = failure as ApiError;
    if (problem.status === 401 || (problem.status === 403 && problem.code === "csrf_mismatch")) {
      // Another tab may have replaced the cookie during first-session creation.
      // Refresh identity, but leave replaying the same checkout to the user.
      expireSession();
      void refresh().catch(() => {});
    }
    if (problem.code === "expired") clearExpired();
    else if (problem.status && [400, 404, 409, 410].includes(problem.status)) {
      writeHold(null);
      save("campus-pending", null);
      setPending(null);
    }
    setError(problem.status ? problem.message : "Connection interrupted. Your checkout ID is saved. Reconnect and retry to check its outcome safely.");
    if (problem.code === "order_cooldown") void refresh().catch(() => {});
    void refreshInventory(true).catch(() => {});
  }
  async function beginCheckout() {
    if (!online || !session || busy.current || pending || !quantity || orderCooldownMs > 0) return;
    // The map confirms a snapped pin; the server validates its path and computes
    // the route. Keep the large walkway graph out of the initial storefront bundle.
    if (!reservationRef.current && (!coordinate(destination) || destination.confirmed !== true)) { setView("map"); return; }
    busy.current = true;
    const epoch = accountEpoch.current;
    setSubmitting(true);
    setError("");
    const attempt: Reservation = reservationRef.current ?? {
      key: crypto.randomUUID(), body: { items: lines.map((p) => ({ id: p.id, quantity: cart[p.id] })), location, destination: destination! },
      phase: "reserving", expiresAt: Date.now() + 300000, clockOffsetMs: 0,
    };
    writeHold(attempt);
    try {
      const result = await requestJson<CheckoutReply>("/api/reservations", {
        method: "POST", headers: headers(attempt.key), body: JSON.stringify(attempt.body),
      });
      if (epoch !== accountEpoch.current) return;
      const reply = await waitForReply(result, attempt.key, false, epoch);
      if (epoch !== accountEpoch.current) return;
      acceptReply(reply, attempt);
      void refreshInventory(true).catch(() => {});
    } catch (failure) { if (epoch === accountEpoch.current) failAction(failure); }
    finally { busy.current = false; setSubmitting(false); }
  }
  async function placeOrder() {
    if (!online || !session || busy.current) return;
    const attempt = reservationRef.current;
    if (attempt?.phase === "reserving") { await beginCheckout(); return; }
    if (!attempt && !pending) return;
    if (attempt && reservationExpired(attempt, Date.now())) { clearExpired(); return; }
    busy.current = true;
    const epoch = accountEpoch.current;
    setSubmitting(true);
    setError("");
    try {
      if (pending && !attempt) {
        const result = await requestJson<CheckoutReply>("/api/orders", {
          method: "POST", headers: headers(pending.key), body: JSON.stringify(pending.body),
        });
        if (epoch !== accountEpoch.current) return;
        const final = await waitForReply(result, pending.key, false, epoch);
        if (epoch !== accountEpoch.current) return;
        if (final.status !== "held" && final.status !== "pending") finishOrder(final);
      } else if (attempt) {
        writeHold({ ...attempt, phase: "confirming" });
        const result = await requestJson<CheckoutReply>(`/api/reservations/${attempt.key}/confirm`, {
          method: "POST", headers: headers(attempt.key),
        });
        if (epoch !== accountEpoch.current) return;
        const reply = await waitForReply(result, attempt.key, true, epoch);
        if (epoch !== accountEpoch.current) return;
        acceptReply(reply, { ...attempt, phase: "confirming" });
      }
    } catch (failure) { if (epoch === accountEpoch.current) failAction(failure); }
    finally { busy.current = false; setSubmitting(false); }
  }
  async function cancelCheckout() {
    const attempt = reservationRef.current;
    if (!attempt || !online || !session || busy.current || attempt.phase === "confirming") return;
    busy.current = true;
    const epoch = accountEpoch.current;
    setSubmitting(true);
    writeHold({ ...attempt, phase: "cancelling" });
    try {
      const result = await requestJson<Order | { status: "cancelled" }>(`/api/reservations/${attempt.key}/cancel`, {
        method: "POST", headers: headers(attempt.key),
      });
      if (epoch !== accountEpoch.current) return;
      if (result.status === "cancelled") {
        writeHold(null);
        setNotice("Reservation cancelled. Your items were released; your bag is kept for editing.");
        void refreshInventory(true).catch(() => {});
      } else finishOrder(result);
    } catch (failure) { if (epoch === accountEpoch.current) failAction(failure); }
    finally { busy.current = false; setSubmitting(false); }
  }
  async function reconnect() {
    if (!navigator.onLine) { setOnline(false); return; }
    setOnline(true);
    setBooting(true);
    try { await refresh(); await refreshInventory(true); await reconcileHold(); setError(""); }
    catch (failure) { const problem = failure as ApiError;
      setError(problem.status === 401 || problem.status === 429 ? problem.message : "Still unable to reach the server. Saved inventory remains available."); }
    finally { setBooting(false); }
  }

  return { ...inventory, session, cart, orders, view, setView, filter, setFilter, storeId, setStoreId, location, destination, setDestination,
    checkout: hasCheckout, online, error, notice, submitting, pending, reservation, secondsLeft, lastApiSuccessAt,
    orderCooldownMs, nextOrderAt: session?.nextOrderAt ?? null,
    booting, lines, quantity, subtotal, total, locked, activeOrders, change, beginCheckout, placeOrder,
    cancelCheckout, reconnect };
}
export type CampusStore = ReturnType<typeof useCampusStore>;
