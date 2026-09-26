import catalog from "../shared/catalog.json" with { type: "json" };
import { eligibleAccountSql } from "./auth.mjs";

export const TICK_MS = 100;
export const INITIAL_STOCK = 20;
export const HOLD_MS = 5 * 60 * 1000;

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
  const records = await inventoryRecords(db, now);
  return new Map([...records].map(([id, record]) => [id, record.stock]));
}

// Read availability and its source metadata together; API reads never mark a sync.
export async function inventoryRecords(db, now = Date.now()) {
  const result = await db.prepare(`SELECT i.product_id,
    i.stock_updated_at, i.synced_at,
    i.quantity - COALESCE((SELECT SUM(quantity) FROM order_items WHERE product_id = i.product_id), 0)
      - ${heldQuantity} AS stock
    FROM inventory i`).bind(now).all();
  return new Map(result.results.map((row) => [row.product_id, {
    stock: row.stock, stockUpdatedAt: row.stock_updated_at, syncedAt: row.synced_at,
  }]));
}

// Server-only seam for the future POS adapter. Include this statement in the
// SAME batch as accepted stock reconciliation. receivedAt is captured by the
// backend when receiving the data, never supplied by the browser/POS payload.
// This helper does not reconcile POS quantities with the demo allocation ledger.
export function inventoryFreshnessStatement(db, productId, stockUpdatedAt = null, receivedAt = Date.now()) {
  const validTime = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
  if (!catalog.products.some((product) => product.id === productId)
    || !validTime(receivedAt) || (stockUpdatedAt !== null && !validTime(stockUpdatedAt))) {
    throw new Error("Valid product and inventory timestamps are required.");
  }
  return db.prepare(`UPDATE inventory SET stock_updated_at = ?, synced_at = ?
    WHERE product_id = ? AND (synced_at IS NULL OR synced_at <= ?)`)
    .bind(stockUpdatedAt, receivedAt, productId, receivedAt);
}

// q is a checkout_queue row. Check every cart line inside the write transaction.
const stockFits = `NOT EXISTS (
  SELECT 1 FROM json_each(q.items) item
  LEFT JOIN inventory i ON i.product_id = json_extract(item.value, '$.id')
  WHERE i.product_id IS NULL OR json_extract(item.value, '$.quantity') >
    i.quantity - COALESCE((SELECT SUM(quantity) FROM order_items WHERE product_id = i.product_id), 0)
      - ${heldQuantity}
)`;
const fundsFit = `q.total <= ? - (SELECT COALESCE(SUM(total), 0) FROM orders WHERE account_id = q.account_id)`;
const cooldownFit = `EXISTS (
  SELECT 1 FROM accounts a
  WHERE a.id = q.account_id AND ${eligibleAccountSql} AND a.cooldown_until <= ?
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
      .bind(now, now, catalog.initialBalanceCents, now, sequence, now),
    db.prepare(`INSERT INTO orders
      (id, session_id, account_id, request_key, request_hash, items, subtotal, total, location, created_at, delivery_route)
      SELECT q.order_id, q.session_id, q.account_id, q.request_key, q.request_hash, q.items, q.subtotal, q.total, q.location, ?, q.delivery_route
      FROM checkout_queue q WHERE q.kind = 'purchase' AND q.sequence = ? AND ${head} AND ${fundsFit} AND ${stockFits} AND ${cooldownFit}
      ON CONFLICT(account_id, request_key) DO NOTHING`)
      .bind(now, sequence, now, catalog.initialBalanceCents, now, now),
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
      .bind(now, catalog.initialBalanceCents, sequence, now),
  ]);
  await db.batch(statements);
}

// Convert a live hold into one purchase atomically. Stock is already held; the
// ledger allocation and status change happen in the same transaction so the
// item is never double-counted or briefly released between those operations.
export async function confirmHold(db, accountId, key, now) {
  await db.batch([
    db.prepare(`INSERT INTO orders
      (id, session_id, account_id, request_key, request_hash, items, subtotal, total, location, created_at, delivery_route)
      SELECT q.order_id, q.session_id, q.account_id, q.request_key, q.request_hash, q.items, q.subtotal, q.total, q.location, ?, q.delivery_route
      FROM checkout_queue q WHERE q.account_id = ? AND q.request_key = ?
        AND q.kind = 'reservation' AND q.status = 'held' AND q.expires_at > ? AND ${fundsFit} AND ${cooldownFit}
      ON CONFLICT(account_id, request_key) DO NOTHING`)
      .bind(now, accountId, key, now, catalog.initialBalanceCents, now),
    db.prepare(`INSERT INTO order_items (order_id, product_id, quantity)
      SELECT o.id, json_extract(item.value, '$.id'), json_extract(item.value, '$.quantity')
      FROM checkout_queue q JOIN orders o ON o.id = q.order_id, json_each(o.items) item
      WHERE q.account_id = ? AND q.request_key = ? AND q.kind = 'reservation'
      ON CONFLICT(order_id, product_id) DO NOTHING`).bind(accountId, key),
    db.prepare(`UPDATE checkout_queue AS q SET status = CASE
      WHEN EXISTS (SELECT 1 FROM orders WHERE id = q.order_id) THEN 'accepted'
      WHEN q.expires_at <= ? THEN 'expired'
      WHEN NOT (${cooldownFit}) THEN 'order_cooldown'
      ELSE 'insufficient_funds' END
      WHERE q.account_id = ? AND q.request_key = ? AND q.kind = 'reservation' AND q.status = 'held'`)
      .bind(now, now, accountId, key),
  ]);
}
