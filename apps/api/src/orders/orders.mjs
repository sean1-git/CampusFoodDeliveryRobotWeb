/**
 * Validates and records demo checkout using server-owned prices and available funds.
 * Reuses a checkout ID on retries to avoid duplicate charges; delivery is simulated.
 */
import catalog from "../../../../packages/domain/src/catalog/catalog.json" with { type: "json" };
import { json, readSmallJson } from "../http/http.mjs";
import { deliveryTimeline } from "../../../../packages/domain/src/campus/campusRouting.ts";
import { pickupRoute, geoTimeline } from "../../../../packages/domain/src/campus/campusGeo.ts";
import { coordinate } from "../../../../packages/domain/src/delivery/deliveryRoute.ts";
import {
  ensureInventory,
  settleTicks,
  confirmHold,
  TICK_MS,
  HOLD_MS,
} from "../inventory/inventory.mjs";
const productsById = new Map(catalog.products.map(product => [product.id, product]));
const uuid = () => crypto.randomUUID();
const validId = (value) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

function intentItems(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const seen = new Set(), items = [];
  for (const item of value) {
    if (typeof item?.id !== "string" || !item.id || item.id.length > 128
      || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20
      || seen.has(item.id)) return null;
    seen.add(item.id);
    items.push({ id: item.id, quantity: item.quantity });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

function intentFingerprint(items, destination) {
  return JSON.stringify({ items, destination: {
    lat: destination.lat, lng: destination.lng, confirmed: true,
  } });
}

function matchesIntent(stored, fingerprint) {
  if (stored === fingerprint) return true;
  // Older hashes included server-owned names and prices. Compare their saved
  // request intent without repricing or rewriting an existing checkout.
  try {
    const legacy = JSON.parse(stored), items = intentItems(legacy?.items);
    return !!items && coordinate(legacy.destination) && legacy.destination.confirmed === true
      && intentFingerprint(items, legacy.destination) === fingerprint;
  } catch { return false; }
}

async function recentOrder(db, accountId, now) {
  const row = await db
    .prepare("SELECT cooldown_until FROM accounts WHERE id = ?")
    .bind(accountId)
    .first();
  if (!row || row.cooldown_until <= now) return null;
  return { retryAt: row.cooldown_until };
}

function orderCooldown(retryAt) {
  return json(
    {
      code: "order_cooldown",
      retryAt,
      error: "Your robot is still completing a delivery. You can place another order as soon as it reaches your confirmed pin.",
    },
    409,
  );
}

// Convert a database row into the response shape and derive progress from elapsed time.
export function publicOrder(row, now) {
  const deliveryRoute = row.delivery_route ? JSON.parse(row.delivery_route) : null;
  const timeline = deliveryRoute ? geoTimeline(deliveryRoute, row.created_at, now) : deliveryTimeline(row.location, row.created_at, now);
  return {
    id: row.id,
    items: JSON.parse(row.items),
    subtotalCents: row.subtotal,
    deliveryFeeCents: row.total - row.subtotal,
    totalCents: row.total,
    location: row.location,
    deliveryRoute,
    createdAt: row.created_at,
    ...timeline,
    serverNow: now,
    mode: "demo",
  };
}

export async function createDemoOrder(request, db, session, now, kind = "purchase") {
  if (request.headers.get("x-csrf-token") !== session.csrf)
    return json(
      { code: "csrf_mismatch", error: "Session validation failed. Reload and try again." },
      403,
    );
  const key = request.headers.get("idempotency-key");
  if (!validId(key))
    return json({ error: "A valid checkout request ID is required." }, 400);
  const body = await readSmallJson(request);
  const requestedItems = intentItems(body?.items);
  if (!requestedItems) {
    return json(
      { error: "The cart contains an invalid product or quantity." },
      400,
    );
  }
  if (!coordinate(body.destination) || body.destination.confirmed !== true)
    return json({ code: "delivery_pin_required", error: "Confirm a delivery pin on a highlighted UC Merced walkway before checkout." }, 400);
  // Fingerprint the submitted point, not a projection that could change with a
  // future map snapshot. Existing orders and holds retain their frozen route.
  const fingerprint = intentFingerprint(requestedItems, body.destination);
  const existing = await db
    .prepare("SELECT * FROM orders WHERE account_id = ? AND request_key = ?")
    .bind(session.account_id, key)
    .first();
  if (existing)
    return matchesIntent(existing.request_hash, fingerprint)
      ? json(publicOrder(existing, now))
      : json(
          { error: "This checkout ID was already used for a different cart." },
        409,
      );
  const queued = await db
    .prepare("SELECT * FROM checkout_queue WHERE account_id = ? AND request_key = ?")
    .bind(session.account_id, key)
    .first();
  if (queued) return matchesIntent(queued.request_hash, fingerprint) && queued.kind === kind
    ? checkoutResult(db, session.account_id, key, now)
    : json({ error: "This checkout ID was already used for a different cart." }, 409);
  // Only new checkouts consult today's catalog. Retries above keep their saved
  // prices and remain recoverable even after a product is removed from sale.
  const items = [];
  for (const item of requestedItems) {
    const product = productsById.get(item.id);
    if (!product) return json({ error: "The cart contains an invalid product or quantity." }, 400);
    items.push({ id: product.id, name: product.name, priceCents: product.priceCents, quantity: item.quantity });
  }
  // Store ownership, eligibility, and final snapped geometry are server-owned.
  const route = pickupRoute(body.destination, items.map(item => productsById.get(item.id).storeId));
  if (!route) return json({ code: "delivery_pin_required", error: "Confirm an exact delivery pin on a highlighted UC Merced walkway before checkout. Pins outside the connected campus paths are not accepted." }, 400);
  route.pickups = route.pickups.map(pickup => ({ ...pickup, items: items
    .filter(item => productsById.get(item.id).storeId === pickup.id)
    .map(item => ({ name: item.name, quantity: item.quantity })) }));
  const recent = await recentOrder(db, session.account_id, now);
  if (recent) return orderCooldown(recent.retryAt);
  const subtotal = items.reduce(
    (sum, item) => sum + item.priceCents * item.quantity,
    0,
  );
  const total = subtotal + catalog.deliveryFeeCents;
  await ensureInventory(db);
  // Expire abandoned reservations (including those never settled to held).
  await db.prepare(
    "UPDATE checkout_queue SET status = 'expired' WHERE account_id = ? AND kind = 'reservation' AND status IN ('pending', 'held') AND expires_at <= ?",
  ).bind(session.account_id, now).run();
  // Progress durable pending purchases left by a disconnected client.
  await settleTicks(db, now);
  // sequence is assigned by the shared database; client timestamps and IDs
  // never decide priority. ready_at is the end of a server-assigned 100 ms tick.
  await db
    .prepare(
      `INSERT INTO checkout_queue (order_id, session_id, account_id, request_key, request_hash, items, subtotal, total, location, ready_at, kind, expires_at, delivery_route)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`,
    )
    .bind(
      uuid(),
      session.id,
      session.account_id,
      key,
      fingerprint,
      JSON.stringify(items),
      subtotal,
      total,
      route.label,
      (Math.floor(now / TICK_MS) + 1) * TICK_MS,
      kind,
      kind === "reservation" ? now + HOLD_MS : 0,
      JSON.stringify(route),
    )
    .run();
  const queuedResult = await db
    .prepare("SELECT * FROM checkout_queue WHERE account_id = ? AND request_key = ?")
    .bind(session.account_id, key)
    .first();
  if (!queuedResult) return json({ code: "active_reservation", error: "Your demo wallet already has a pending checkout. Finish or cancel it before starting another." }, 409);
  if (!matchesIntent(queuedResult.request_hash, fingerprint) || queuedResult.kind !== kind)
    return json(
      { error: "This checkout ID was already used for a different cart." },
      409,
    );
  // A request drives its tick while alive. Pending state is durable: a later
  // retry or status poll resumes settlement after a disconnect/Worker restart.
  if (queuedResult.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, Math.min(TICK_MS, Math.max(0, queuedResult.ready_at - Date.now()))));
  }
  return checkoutResult(db, session.account_id, key, Date.now());
}

export async function checkoutResult(db, accountId, key, now) {
  // Check ownership before allowing this endpoint to process any queue work.
  let queued = await db.prepare(
    "SELECT * FROM checkout_queue WHERE account_id = ? AND request_key = ?",
  ).bind(accountId, key).first();
  if (!queued) return json({ error: "Checkout not found." }, 404);
  if (queued.status === "pending") {
    await settleTicks(db, now);
    queued = await db.prepare("SELECT * FROM checkout_queue WHERE sequence = ?")
      .bind(queued.sequence).first();
  }
  if (queued.status === "pending") {
    return json({ status: "pending", requestKey: key, retryAfterMs: TICK_MS }, 202);
  }
  if (queued.kind === "reservation" && queued.status === "held" && queued.expires_at > now) {
    return json({ status: "held", requestKey: key, expiresAt: queued.expires_at, serverNow: now });
  }
  if (queued.status === "expired" || (queued.status === "held" && queued.expires_at <= now)) {
    return json({ code: "expired", error: "Your five-minute checkout reservation expired. All items were released; no demo funds were charged." }, 410);
  }
  if (queued.status === "cancelled") return json({ code: "cancelled", error: "Your checkout reservation was cancelled." }, 410);
  if (queued.status === "order_cooldown") {
    const account = await db.prepare("SELECT cooldown_until FROM accounts WHERE id = ?")
      .bind(accountId).first();
    // Retrying a rejected checkout must never invent or extend a deadline.
    return orderCooldown(account?.cooldown_until ?? now);
  }
  if (queued.status !== "accepted") {
    return json({ code: queued.status, error: queued.status === "sold_out"
      ? "An item in your bag sold out before your turn. No demo funds were charged. Please update your bag."
      : "Not enough demo funds. Remove an item or reduce the quantity." }, 409);
  }
  const order = await db.prepare("SELECT * FROM orders WHERE id = ? AND account_id = ?")
    .bind(queued.order_id, accountId).first();
  return json(publicOrder(order, now), 201);
}

export async function reservationAction(request, db, session, key, action, now) {
  if (request.headers.get("x-csrf-token") !== session.csrf) {
    return json({ code: "csrf_mismatch", error: "Session validation failed. Reload and try again." }, 403);
  }
  const queued = await db.prepare("SELECT * FROM checkout_queue WHERE account_id = ? AND request_key = ? AND kind = 'reservation'")
    .bind(session.account_id, key).first();
  if (!queued) return json({ error: "Checkout not found." }, 404);
  if (action === "cancel") {
    await db.prepare("UPDATE checkout_queue SET status = 'cancelled' WHERE sequence = ? AND status IN ('pending', 'held')")
      .bind(queued.sequence).run();
    // A racing confirmation must be returned as a purchase, never as cancelled.
    const result = await db.prepare("SELECT status FROM checkout_queue WHERE sequence = ?").bind(queued.sequence).first();
    return result.status === "accepted" ? checkoutResult(db, session.account_id, key, now) : json({ status: "cancelled" });
  }
  if (queued.status !== "accepted" && !queued.delivery_route) return json({ code: "delivery_pin_required", error: "Cancel this old checkout and confirm a delivery pin before purchasing." }, 400);
  if (queued.status === "pending") await settleTicks(db, now);
  await confirmHold(db, session.account_id, key, now);
  return checkoutResult(db, session.account_id, key, now);
}
