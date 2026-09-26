/**
 * Routes /api requests and resolves server-issued demo or student sessions.
 * Restricts orders to the account and delegates simulated checkout to orders.mjs.
 */
import { json } from "./http.mjs";
import { publicOrder, createDemoOrder, checkoutResult, reservationAction } from "./orders.mjs";
import { ensureInventory, inventoryRecords } from "./inventory.mjs";
import { authenticatedSession, issueDemoSession } from "./auth.mjs";
import { canonicalOrigin } from "./origin.mjs";
export { secureResponse } from "./http.mjs";
import catalog from "../shared/catalog.json" with { type: "json" };

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
    if (url.pathname === "/api/maps-config" && request.method === "GET") {
      // A browser key is intentionally public; provider-side referrer and API restrictions apply.
      return json({ apiKey: env.GOOGLE_MAPS_BROWSER_KEY || null });
    }
    if (request.method !== "GET" && request.method !== "POST")
      return json({ error: "Method not allowed." }, 405, {
        Allow: "GET, POST",
      });
    // Checkout must originate from this site; orders.mjs also checks the CSRF token.
    if (request.method === "POST") {
      const allowed = new Set([canonicalOrigin(env.CANONICAL_ORIGIN, env.NODE_ENV === "production") || url.origin,
        ...configuredOrigins(env)]);
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
      const inventory = await inventoryRecords(db, now);
      return json({ ...catalog, products: catalog.products.map((p) => ({
        ...p, ...(inventory.get(p.id) ?? { stock: 0, stockUpdatedAt: null, syncedAt: null }),
      })), mode: "demo", responseGeneratedAt: now });
    }
    let session = await authenticatedSession(request, db, now, true);
    let sessionCookie;
    if (!session && url.pathname === "/api/session" && request.method === "GET") {
      const allowed = new Set([canonicalOrigin(env.CANONICAL_ORIGIN, env.NODE_ENV === "production") || url.origin,
        ...configuredOrigins(env)]);
      if (request.headers.get("sec-fetch-site") === "cross-site"
        || (request.headers.has("origin") && !allowed.has(request.headers.get("origin")))) {
        return json({ error: "Request origin is not allowed." }, 403);
      }
      session = await issueDemoSession(db, now, env.NODE_ENV === "production" || url.protocol === "https:");
      sessionCookie = session.cookie;
    }
    if (!session) return json({ code: "authentication_required",
      error: "Your demo session expired. Reconnect to start a new demo wallet." }, 401);
    if (url.pathname === "/api/session" && request.method === "GET") {
      const spent = await db
        .prepare(
          "SELECT COALESCE(SUM(total), 0) AS spent FROM orders WHERE account_id = ?",
        )
        .bind(session.account_id)
        .first();
      const account = await db
        .prepare("SELECT cooldown_until FROM accounts WHERE id = ?")
        .bind(session.account_id)
        .first();
      return json(
        {
          csrf: session.csrf,
          accountId: session.account_id,
          balanceCents: catalog.initialBalanceCents - spent.spent,
          nextOrderAt: account.cooldown_until || null,
          mode: "demo",
        },
        200,
        sessionCookie ? { "Set-Cookie": sessionCookie } : {},
      );
    }
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
      return await checkoutResult(db, session.account_id, key, now);
    }
    if (url.pathname === "/api/orders" && request.method === "GET") {
      const result = await db
        .prepare(
          "SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC LIMIT 50",
        )
        .bind(session.account_id)
        .all();
      return json({
        orders: result.results.map((row) => publicOrder(row, now)),
      });
    }
    if (url.pathname.startsWith("/api/orders/") && request.method === "GET") {
      const id = url.pathname.slice("/api/orders/".length);
      const row = await db
        .prepare("SELECT * FROM orders WHERE id = ? AND account_id = ?")
        .bind(id, session.account_id)
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
