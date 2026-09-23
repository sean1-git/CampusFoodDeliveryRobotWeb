/**
 * Routes /api requests, creates demo cookie sessions, and returns catalog or order data.
 * Restricts order access to the current session and delegates checkout to orders.mjs.
 */
import { json } from "./http.mjs";
import { publicOrder, createDemoOrder, checkoutResult, reservationAction } from "./orders.mjs";
import { ensureInventory, availableInventory, ORDER_COOLDOWN_MS } from "./inventory.mjs";
export { secureResponse } from "./http.mjs";
import catalog from "../shared/catalog.json" with { type: "json" };

const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const cookieName = "campus_demo_session";
const uuid = () => crypto.randomUUID();
const configuredOrigins = (env) =>
  String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
const validId = (value) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
// This handler deliberately supports demo mode only. Real integration adapters
// must be implemented and reviewed before any actual charge or robot dispatch.
export async function handleApi(request, env, now = Date.now()) {
  try {
    if (env.INTEGRATION_MODE && env.INTEGRATION_MODE !== "demo") {
      return json(
        {
          error:
            "Live integrations are not configured. No payment or dispatch was attempted.",
        },
        503,
      );
    }
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "POST")
      return json({ error: "Method not allowed." }, 405, {
        Allow: "GET, POST",
      });
    // Checkout must originate from this site; orders.mjs also checks the CSRF token.
    if (request.method === "POST") {
      const allowed = new Set([url.origin, ...configuredOrigins(env)]);
      if (
        !allowed.has(request.headers.get("origin")) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      ) {
        return json({ error: "Request origin is not allowed." }, 403);
      }
    }
    const db = env.DB;
    if (!db)
      return json({ error: "The demo store is temporarily unavailable." }, 503);
    if (url.pathname === "/api/catalog" && request.method === "GET") {
      await ensureInventory(db);
      const stock = await availableInventory(db, now);
      return json({ ...catalog, products: catalog.products.map((p) => ({
        ...p, stock: stock.get(p.id) ?? 0,
      })), mode: "demo", inventoryUpdatedAt: now });
    }
    const sessionId = request.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    let session = validId(sessionId)
      ? await db
          .prepare("SELECT * FROM sessions WHERE id = ? AND created_at > ?")
          .bind(sessionId, now - SESSION_AGE)
          .first()
      : null;
    if (url.pathname === "/api/session" && request.method === "GET") {
      const headers = {};
      if (!session) {
        session = { id: uuid(), csrf: uuid(), created_at: now };
        await db
          .prepare(
            "INSERT INTO sessions (id, csrf, created_at) VALUES (?, ?, ?)",
          )
          .bind(session.id, session.csrf, now)
          .run();
        headers["Set-Cookie"] =
          `${cookieName}=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${url.protocol === "https:" ? "; Secure" : ""}`;
      }
      const spent = await db
        .prepare(
          "SELECT COALESCE(SUM(total), 0) AS spent FROM orders WHERE session_id = ?",
        )
        .bind(session.id)
        .first();
      const lastOrder = await db
        .prepare("SELECT created_at FROM orders WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
        .bind(session.id)
        .first();
      return json(
        {
          csrf: session.csrf,
          balanceCents: catalog.initialBalanceCents - spent.spent,
          nextOrderAt: lastOrder ? lastOrder.created_at + ORDER_COOLDOWN_MS : null,
          mode: "demo",
        },
        200,
        headers,
      );
    }
    // All order routes below require a valid demo session.
    if (!session)
      return json(
        { error: "Your demo session expired. Reload to start a new session." },
        401,
      );
    if (url.pathname === "/api/reservations" && request.method === "POST") {
      return await createDemoOrder(request, db, session, now, "reservation");
    }
    const reservationPath = /^\/api\/reservations\/([0-9a-f-]{36})\/(confirm|cancel)$/i.exec(url.pathname);
    if (reservationPath && request.method === "POST") {
      return await reservationAction(request, db, session, reservationPath[1], reservationPath[2].toLowerCase(), now);
    }
    if (url.pathname.startsWith("/api/checkouts/") && request.method === "GET") {
      const key = url.pathname.slice("/api/checkouts/".length);
      if (!validId(key)) return json({ error: "Checkout not found." }, 404);
      return await checkoutResult(db, session.id, key, now);
    }
    if (url.pathname === "/api/orders" && request.method === "GET") {
      const result = await db
        .prepare(
          "SELECT * FROM orders WHERE session_id = ? ORDER BY created_at DESC LIMIT 50",
        )
        .bind(session.id)
        .all();
      return json({
        orders: result.results.map((row) => publicOrder(row, now)),
      });
    }
    if (url.pathname.startsWith("/api/orders/") && request.method === "GET") {
      const id = url.pathname.slice("/api/orders/".length);
      const row = await db
        .prepare("SELECT * FROM orders WHERE id = ? AND session_id = ?")
        .bind(id, session.id)
        .first();
      return row
        ? json(publicOrder(row, now))
        : json({ error: "Order not found." }, 404);
    }
    if (url.pathname !== "/api/orders" || request.method !== "POST")
      return json({ error: "Not found." }, 404);
    return await createDemoOrder(request, db, session, now);
  } catch (error) {
    if (["JSON_REQUIRED", "INVALID_JSON", "TOO_LARGE"].includes(error.message))
      return json(
        { error: "The checkout request is invalid or too large." },
        400,
      );
    console.error("Campus demo API request failed:", error.name);
    return json(
      {
        error:
          "The store could not complete this request. Your checkout can be safely retried.",
      },
      503,
    );
  }
}
