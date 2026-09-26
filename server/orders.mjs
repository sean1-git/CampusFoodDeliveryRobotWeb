/**
 * Validates and records demo checkout using server-owned prices and available funds.
 * Reuses a checkout ID on retries to avoid duplicate charges; delivery is simulated.
 */
import catalog from "../shared/catalog.json" with { type: "json" };
import { json, readSmallJson } from "./http.mjs";
import { deliveryTimeline } from "../shared/campusRouting.ts";
import {
  ensureInventory,
  settleTicks,
  confirmHold,
  TICK_MS,
  HOLD_MS,
} from "./inventory.mjs";
const uuid = () => crypto.randomUUID();
const validId = (value) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

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
      error: "Multiple order requests detected. You can place only one robot order per hour. Please wait before placing another order.",
    },
    409,
  );
}

// Convert a database row into the response shape and derive progress from elapsed time.
export function publicOrder(row, now) {
  const timeline = deliveryTimeline(row.location, row.created_at, now);
  return {
    id: row.id,
    items: JSON.parse(row.items),
    subtotalCents: row.subtotal,
    deliveryFeeCents: catalog.deliveryFeeCents,
    totalCents: row.total,
    location: row.location,
    createdAt: row.created_at,
    ...timeline,
    serverNow: now,
    mode: "demo",
  };
}

export async function createDemoOrder(request, db, session, now, kind = "purchase") {
  if (request.headers.get("x-csrf-token") !== session.csrf)
    return json(
      { error: "Session validation failed. Reload and try again." },
      403,
    );
  const key = request.headers.get("idempotency-key");
  if (!validId(key))
    return json({ error: "A valid checkout request ID is required." }, 400);
  const body = await readSmallJson(request);
  if (
    !body ||
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > 6 ||
    !catalog.locations.includes(body.location)
  ) {
    return json(
      { error: "Choose products and a supported delivery location." },
      400,
    );
  }
  // Use only catalog prices; browser-supplied prices must not determine the charge.
  const seen = new Set();
  const items = [];
  for (const item of body.items) {
    const product = catalog.products.find((p) => p.id === item?.id);
    if (
      !product ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 20 ||
      seen.has(item.id)
    ) {
      return json(
        { error: "The cart contains an invalid product or quantity." },
        400,
      );
    }
    seen.add(item.id);
    items.push({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      quantity: item.quantity,
    });
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = JSON.stringify({ items, location: body.location });
  const existing = await db
    .prepare("SELECT * FROM orders WHERE account_id = ? AND request_key = ?")
    .bind(session.account_id, key)
    .first();
  if (existing)
    return existing.request_hash === fingerprint
      ? json(publicOrder(existing, now))
      : json(
          { error: "This checkout ID was already used for a different cart." },
        409,
      );
  const queued = await db
    .prepare("SELECT * FROM checkout_queue WHERE account_id = ? AND request_key = ?")
    .bind(session.account_id, key)
    .first();
  if (!existing && !queued) {
    const recent = await recentOrder(db, session.account_id, now);
    if (recent) return orderCooldown(recent.retryAt);
  }
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
      `INSERT INTO checkout_queue (order_id, session_id, account_id, request_key, request_hash, items, subtotal, total, location, ready_at, kind, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      body.location,
      (Math.floor(now / TICK_MS) + 1) * TICK_MS,
      kind,
      kind === "reservation" ? now + HOLD_MS : 0,
    )
    .run();
  const queuedResult = await db
    .prepare("SELECT * FROM checkout_queue WHERE account_id = ? AND request_key = ?")
    .bind(session.account_id, key)
    .first();
  if (!queuedResult) return json({ code: "active_reservation", error: "Your demo wallet already has a pending checkout. Finish or cancel it before starting another." }, 409);
  if (queuedResult.request_hash !== fingerprint || queuedResult.kind !== kind)
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
    return json({ error: "Session validation failed. Reload and try again." }, 403);
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
  if (queued.status === "pending") await settleTicks(db, now);
  await confirmHold(db, session.account_id, key, now);
  return checkoutResult(db, session.account_id, key, now);
}
