/**
 * Coordinates shopping state: loads demo data, saves the bag, submits checkout,
 * and refreshes orders. Components receive this state and the actions that change it.
 */
import { useCallback, useEffect, useState } from "react";
import sampleCatalog from "../../shared/catalog.json";
import type { Cart, Order, Pending, Product, Session } from "../types";
import { requestJson } from "../lib/api";
import { initialCart, load, save } from "../lib/storage";

export function useCampusStore() {
  const [catalog, setCatalog] = useState(sampleCatalog);
  const [session, setSession] = useState<Session | null>(null);
  const [cart, setCart] = useState<Cart>(initialCart);
  const [orders, setOrders] = useState<Order[]>([]);
  const [view, setView] = useState<"shop" | "orders">("shop");
  const [filter, setFilter] = useState("All items");
  const [location, setLocation] = useState(sampleCatalog.locations[0]);
  const [checkout, setCheckout] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<Pending | null>(() =>
    load<Pending | null>("campus-pending", null),
  );
  const [booting, setBooting] = useState(true);

  // Fetch the balance and orders from the server, which owns the demo purchase records.
  const refresh = useCallback(async () => {
    const user = await requestJson<Session>("/api/session");
    setSession(user);
    const data = await requestJson<{ orders: Order[] }>("/api/orders");
    setOrders(data.orders);
    return data.orders;
  }, []);

  useEffect(() => {
    save("campus-cart", cart);
  }, [cart]);
  useEffect(() => {
    save("campus-pending", pending);
  }, [pending]);
  useEffect(() => {
    let active = true;
    async function start() {
      try {
        const data = await requestJson<typeof sampleCatalog>("/api/catalog");
        if (active) {
          setCatalog(data);
          await refresh();
          setError("");
        }
      } catch {
        if (active)
          setError(
            "The demo server is unavailable. You can browse the sample menu; reconnect to place an order.",
          );
      } finally {
        if (active) setBooting(false);
      }
    }
    void start();
    const onOnline = () => {
      setOnline(true);
      void start();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      active = false;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [refresh]);

  // Poll only while connected with a session; cleanup prevents duplicate timers.
  const csrf = session?.csrf;
  useEffect(() => {
    if (!online || !csrf) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [online, csrf, refresh]);

  const lines = catalog.products.filter((p) => cart[p.id] > 0);
  const quantity = lines.reduce((sum, p) => sum + cart[p.id], 0);
  const subtotal = lines.reduce((sum, p) => sum + p.priceCents * cart[p.id], 0);
  const total = subtotal + (quantity ? catalog.deliveryFeeCents : 0);
  // Keep the cart fixed while a checkout is unresolved so retries use the same items.
  const locked = submitting || !!pending;
  const activeOrders = orders.filter((o) => o.status !== "delivered").length;

  function change(product: Product, amount: number) {
    if (locked) return;
    setCart((old) => ({
      ...old,
      [product.id]: Math.min(20, Math.max(0, (old[product.id] || 0) + amount)),
    }));
    setNotice(
      amount > 0
        ? `${product.name} added to your bag.`
        : `${product.name} quantity updated.`,
    );
  }
  async function placeOrder() {
    if (!online || !session || submitting) return;
    setSubmitting(true);
    setError("");
    // Save one request ID and payload before sending. If the response is lost,
    // retry the same request so the server can return the existing order.
    const attempt = pending ?? {
      key: crypto.randomUUID(),
      body: {
        items: lines.map((p) => ({ id: p.id, quantity: cart[p.id] })),
        location,
      },
    };
    save("campus-pending", attempt);
    setPending(attempt);
    try {
      const order = await requestJson<Order>("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
          "Idempotency-Key": attempt.key,
        },
        body: JSON.stringify(attempt.body),
      });
      save("campus-pending", null);
      setPending(null);
      setCart({});
      setCheckout(false);
      setView("orders");
      setOrders((old) => [order, ...old.filter((o) => o.id !== order.id)]);
      setNotice(
        "Demo order placed. No real money was charged and no robot was dispatched.",
      );
      await refresh().catch(() => {});
    } catch (failure) {
      const problem = failure as Error & { status?: number };
      if (problem.status && problem.status >= 400 && problem.status < 500) {
        save("campus-pending", null);
        setPending(null);
      }
      setError(
        problem.status
          ? problem.message
          : "Connection interrupted. Use “Retry this checkout” to check the same order safely. Your bag is saved.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function reconnect() {
    setBooting(true);
    try {
      await refresh();
      setError("");
    } catch {
      setError("Still unable to reach the demo server. Please try again.");
    } finally {
      setBooting(false);
    }
  }

  return {
    catalog,
    session,
    cart,
    orders,
    view,
    setView,
    filter,
    setFilter,
    location,
    setLocation,
    checkout,
    setCheckout,
    online,
    error,
    notice,
    submitting,
    pending,
    booting,
    lines,
    quantity,
    subtotal,
    total,
    locked,
    activeOrders,
    change,
    placeOrder,
    reconnect,
  };
}

export type CampusStore = ReturnType<typeof useCampusStore>;
