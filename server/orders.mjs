/**
 * Validates and records demo checkout using server-owned prices and available funds.
 * Reuses a checkout ID on retries to avoid duplicate charges; delivery is simulated.
 */
import catalog from "../shared/catalog.json" with { type: "json" };
import { json, readSmallJson } from "./http.mjs";
import { ensureInventory, settleTicks, TICK_MS } from "./inventory.mjs";
const uuid = () => crypto.randomUUID();
const validId = (value) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

// Convert a database row into the response shape and derive progress from elapsed time.
export function publicOrder(row, now) {
  const elapsed = now - row.created_at;
  return {
    id: row.id,
    items: JSON.parse(row.items),
    subtotalCents: row.subtotal,
    deliveryFeeCents: catalog.deliveryFeeCents,
    totalCents: row.total,
    location: row.location,
    createdAt: row.created_at,
    arrivesAt: row.created_at + 65000,
    status:
      elapsed < 20000
        ? "preparing"
        : elapsed < 65000
          ? "delivering"
          : "delivered",
    mode: "demo",
  };
}

export async function createDemoOrder(request, db, session, now) {
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
    .prepare("SELECT * FROM orders WHERE session_id = ? AND request_key = ?")
    .bind(session.id, key)
    .first();
  if (existing)
    return existing.request_hash === fingerprint
      ? json(publicOrder(existing, now))
      : json(
          { error: "This checkout ID was already used for a different cart." },
          409,
        );
  const subtotal = items.reduce(
    (sum, item) => sum + item.priceCents * item.quantity,
    0,
  );
  const total = subtotal + catalog.deliveryFeeCents;
  await ensureInventory(db);
  // sequence is assigned by the shared database; client timestamps and IDs
  // never decide priority. ready_at is the end of a server-assigned 100 ms tick.
  await db
    .prepare(
      `INSERT INTO checkout_queue (order_id, session_id, request_key, request_hash, items, subtotal, total, location, ready_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, request_key) DO NOTHING`,
    )
    .bind(
      uuid(),
      session.id,
      key,
      fingerprint,
      JSON.stringify(items),
      subtotal,
      total,
      body.location,
      (Math.floor(now / TICK_MS) + 1) * TICK_MS,
    )
    .run();
  const queued = await db
    .prepare("SELECT * FROM checkout_queue WHERE session_id = ? AND request_key = ?")
    .bind(session.id, key)
    .first();
  if (queued.request_hash !== fingerprint)
    return json(
      { error: "This checkout ID was already used for a different cart." },
      409,
    );
  // A request drives its tick while alive. Pending state is durable: a later
  // retry or status poll resumes settlement after a disconnect/Worker restart.
  if (queued.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, Math.min(TICK_MS, Math.max(0, queued.ready_at - Date.now()))));
  }
  return checkoutResult(db, session.id, key, Date.now());
}

export async function checkoutResult(db, sessionId, key, now) {
  // Check ownership before allowing this endpoint to process any queue work.
  let queued = await db.prepare(
    "SELECT * FROM checkout_queue WHERE session_id = ? AND request_key = ?",
  ).bind(sessionId, key).first();
  if (!queued) return json({ error: "Checkout not found." }, 404);
  if (queued.status === "pending") {
    await settleTicks(db, now);
    queued = await db.prepare("SELECT * FROM checkout_queue WHERE sequence = ?")
      .bind(queued.sequence).first();
  }
  if (queued.status === "pending") {
    return json({ status: "pending", requestKey: key, retryAfterMs: TICK_MS }, 202);
  }
  if (queued.status !== "accepted") {
    return json({ code: queued.status, error: queued.status === "sold_out"
      ? "An item in your bag sold out before your turn. No demo funds were charged. Please update your bag."
      : "Not enough demo funds. Remove an item or reduce the quantity." }, 409);
  }
  const order = await db.prepare("SELECT * FROM orders WHERE id = ? AND session_id = ?")
    .bind(queued.order_id, sessionId).first();
  return json(publicOrder(order, now), 201);
}
