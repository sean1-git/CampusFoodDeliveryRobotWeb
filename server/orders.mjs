/**
 * Validates and records demo checkout using server-owned prices and available funds.
 * Reuses a checkout ID on retries to avoid duplicate charges; delivery is simulated.
 */
import catalog from "../shared/catalog.json" with { type: "json" };
import { json, readSmallJson } from "./http.mjs";
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
  const id = uuid();
  // One SQLite statement atomically checks the balance and writes the order.
  // A unique session/request key prevents retries from charging twice.
  await db
    .prepare(
      `INSERT INTO orders (id, session_id, request_key, request_hash, items, subtotal, total, location, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ? <= ? - (SELECT COALESCE(SUM(total), 0) FROM orders WHERE session_id = ?)
      ON CONFLICT(session_id, request_key) DO NOTHING`,
    )
    .bind(
      id,
      session.id,
      key,
      fingerprint,
      JSON.stringify(items),
      subtotal,
      total,
      body.location,
      now,
      total,
      catalog.initialBalanceCents,
      session.id,
    )
    .run();
  const row = await db
    .prepare("SELECT * FROM orders WHERE session_id = ? AND request_key = ?")
    .bind(session.id, key)
    .first();
  if (!row)
    return json(
      {
        error: "Not enough demo funds. Remove an item or reduce the quantity.",
      },
      409,
    );
  if (row.request_hash !== fingerprint)
    return json(
      { error: "This checkout ID was already used for a different cart." },
      409,
    );
  return json(publicOrder(row, now), row.id === id ? 201 : 200);
}
