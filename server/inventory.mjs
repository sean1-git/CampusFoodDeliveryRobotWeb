import catalog from "../shared/catalog.json" with { type: "json" };

export const TICK_MS = 100;
export const INITIAL_STOCK = 20;
export const HOLD_MS = 5 * 60 * 1000;
export const ORDER_COOLDOWN_MS = 60 * 60 * 1000;

// Expired holds stop counting immediately, even if no cleanup request has run.
const heldQuantity = `(SELECT COALESCE(SUM(json_extract(held.value, '$.quantity')), 0)
  FROM checkout_queue reservation, json_each(reservation.items) held
  WHERE reservation.status = 'held' AND reservation.expires_at > ?
    AND json_extract(held.value, '$.id') = i.product_id)`;

// Insert once; refreshing or restarting the app never replenishes sold stock.
export async function ensureInventory(db) {
  await db.prepare(`INSERT INTO inventory (product_id, quantity)
    SELECT json_extract(value, '$.id'), ? FROM json_each(?) WHERE true
    ON CONFLICT(product_id) DO NOTHING`)
    .bind(INITIAL_STOCK, JSON.stringify(catalog.products)).run();
}

export async function availableInventory(db, now = Date.now()) {
  const result = await db.prepare(`SELECT i.product_id,
    i.quantity - COALESCE((SELECT SUM(quantity) FROM order_items WHERE product_id = i.product_id), 0)
      - ${heldQuantity} AS stock
    FROM inventory i`).bind(now).all();
  return new Map(result.results.map((row) => [row.product_id, row.stock]));
}

// q is a checkout_queue row. Check every cart line inside the write transaction.
const stockFits = `NOT EXISTS (
  SELECT 1 FROM json_each(q.items) item
  LEFT JOIN inventory i ON i.product_id = json_extract(item.value, '$.id')
  WHERE i.product_id IS NULL OR json_extract(item.value, '$.quantity') >
    i.quantity - COALESCE((SELECT SUM(quantity) FROM order_items WHERE product_id = i.product_id), 0)
      - ${heldQuantity}
)`;
const fundsFit = `q.total <= ? - (SELECT COALESCE(SUM(total), 0) FROM orders WHERE session_id = q.session_id)`;
const cooldownFit = `NOT EXISTS (
  SELECT 1 FROM orders recent
  WHERE recent.session_id = q.session_id
    AND recent.created_at > ? - ?
)`;
const head = `q.status = 'pending' AND q.ready_at <= ?
  AND q.sequence = (SELECT MIN(sequence) FROM checkout_queue WHERE status = 'pending')`;

// Multiple Workers can run this concurrently. The database, not a process-local
// timer/lock, serializes each atomic batch. The head guard prevents overtaking,
// even when a worker reads a stale queue snapshot or retries after losing a reply.
export async function settleTicks(db, now) {
  const queued = await db.prepare(`SELECT sequence FROM checkout_queue
    WHERE status = 'pending' ORDER BY sequence LIMIT 8`).bind().all();
  if (!queued.results.length) return;
  const statements = queued.results.flatMap(({ sequence }) => [
    db.prepare(`UPDATE checkout_queue AS q SET status = CASE
      WHEN q.expires_at <= ? THEN 'expired'
      WHEN NOT (${cooldownFit}) THEN 'order_cooldown'
      WHEN NOT (${fundsFit}) THEN 'insufficient_funds'
      WHEN ${stockFits} THEN 'held' ELSE 'sold_out' END
      WHERE q.kind = 'reservation' AND q.sequence = ? AND ${head}`)
      .bind(now, now, ORDER_COOLDOWN_MS, catalog.initialBalanceCents, now, sequence, now),
    db.prepare(`INSERT INTO orders
      (id, session_id, request_key, request_hash, items, subtotal, total, location, created_at)
      SELECT q.order_id, q.session_id, q.request_key, q.request_hash, q.items, q.subtotal, q.total, q.location, ?
      FROM checkout_queue q WHERE q.kind = 'purchase' AND q.sequence = ? AND ${head} AND ${fundsFit} AND ${stockFits} AND ${cooldownFit}
      ON CONFLICT(session_id, request_key) DO NOTHING`)
      .bind(now, sequence, now, catalog.initialBalanceCents, now, now, ORDER_COOLDOWN_MS),
    db.prepare(`INSERT INTO order_items (order_id, product_id, quantity)
      SELECT o.id, json_extract(item.value, '$.id'), json_extract(item.value, '$.quantity')
      FROM checkout_queue q JOIN orders o ON o.id = q.order_id, json_each(o.items) item
      WHERE q.sequence = ? AND q.status = 'pending'
      ON CONFLICT(order_id, product_id) DO NOTHING`).bind(sequence),
    db.prepare(`UPDATE checkout_queue AS q SET status = CASE
      WHEN EXISTS (SELECT 1 FROM orders WHERE id = q.order_id) THEN 'accepted'
      WHEN NOT (${cooldownFit}) THEN 'order_cooldown'
      WHEN NOT (${fundsFit}) THEN 'insufficient_funds' ELSE 'sold_out' END
      WHERE q.kind = 'purchase' AND q.sequence = ? AND ${head}`)
      .bind(now, ORDER_COOLDOWN_MS, catalog.initialBalanceCents, sequence, now),
  ]);
  await db.batch(statements);
}

// Convert a live hold into one purchase atomically. Stock is already held; the
// ledger allocation and status change happen in the same transaction so the
// item is never double-counted or briefly released between those operations.
export async function confirmHold(db, sessionId, key, now) {
  await db.batch([
    db.prepare(`INSERT INTO orders
      (id, session_id, request_key, request_hash, items, subtotal, total, location, created_at)
      SELECT q.order_id, q.session_id, q.request_key, q.request_hash, q.items, q.subtotal, q.total, q.location, ?
      FROM checkout_queue q WHERE q.session_id = ? AND q.request_key = ?
        AND q.kind = 'reservation' AND q.status = 'held' AND q.expires_at > ? AND ${fundsFit} AND ${cooldownFit}
      ON CONFLICT(session_id, request_key) DO NOTHING`)
      .bind(now, sessionId, key, now, catalog.initialBalanceCents, now, ORDER_COOLDOWN_MS),
    db.prepare(`INSERT INTO order_items (order_id, product_id, quantity)
      SELECT o.id, json_extract(item.value, '$.id'), json_extract(item.value, '$.quantity')
      FROM checkout_queue q JOIN orders o ON o.id = q.order_id, json_each(o.items) item
      WHERE q.session_id = ? AND q.request_key = ? AND q.kind = 'reservation'
      ON CONFLICT(order_id, product_id) DO NOTHING`).bind(sessionId, key),
    db.prepare(`UPDATE checkout_queue AS q SET status = CASE
      WHEN EXISTS (SELECT 1 FROM orders WHERE id = q.order_id) THEN 'accepted'
      WHEN q.expires_at <= ? THEN 'expired'
      WHEN NOT (${cooldownFit}) THEN 'order_cooldown'
      ELSE 'insufficient_funds' END
      WHERE q.session_id = ? AND q.request_key = ? AND q.kind = 'reservation' AND q.status = 'held'`)
      .bind(now, now, ORDER_COOLDOWN_MS, sessionId, key),
  ]);
}
