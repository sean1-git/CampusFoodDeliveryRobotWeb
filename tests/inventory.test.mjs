import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/local-db.mjs";
import { handleApi } from "../server/api.mjs";
import { ensureInventory, availableInventory, settleTicks } from "../server/inventory.mjs";

const origin = "https://campus.test";
async function fixture(t, file) {
  const DB = openDatabase(file);
  t.after(() => DB.close());
  await ensureInventory(DB);
  await DB.prepare("UPDATE inventory SET quantity = 1 WHERE product_id = 'sandwich'").run();
  const users = [];
  for (let i = 0; i < 12; i++) {
    const response = await handleApi(new Request(origin + "/api/session"), { DB });
    const cookie = response.headers.get("set-cookie").split(";")[0];
    users.push({ cookie, id: cookie.split("=")[1], ...(await response.json()) });
  }
  const call = (user, path, options = {}) => handleApi(new Request(origin + path, {
    ...options, headers: { cookie: user.cookie, origin, "content-type": "application/json",
      "x-csrf-token": user.csrf, ...options.headers },
  }), { DB });
  async function purchase(user, key = crypto.randomUUID(), items = [{ id: "sandwich", quantity: 1 }]) {
    let response = await call(user, "/api/orders", { method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ items, location: "Library entrance" }),
    });
    for (let i = 0; response.status === 202 && i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      response = await call(user, `/api/checkouts/${key}`);
    }
    return { status: response.status, body: await response.json() };
  }
  async function enqueue(user, readyAt, { total = 750, quantity = 1 } = {}) {
    const key = crypto.randomUUID();
    await DB.prepare(`INSERT INTO checkout_queue
      (session_id, request_key, request_hash, order_id, items, subtotal, total, location, ready_at)
      VALUES (?, ?, 'test', ?, ?, ?, ?, 'Library entrance', ?)`)
      .bind(user.id, key, crypto.randomUUID(), JSON.stringify([{ id: "sandwich", name: "Sandwich", priceCents: 650, quantity }]),
        total - 100, total, readyAt).run();
    return key;
  }
  return { DB, users, call, purchase, enqueue };
}

test("twelve simultaneous visitors: exactly one gets the last item, losers are not charged", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(f.users.map((u) => f.purchase(u)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409 && r.body.code === "sold_out").length, 11);
  assert.equal((await availableInventory(f.DB)).get("sandwich"), 0);
  for (let i = 0; i < f.users.length; i++) {
    const wallet = await (await f.call(f.users[i], "/api/session")).json();
    assert.equal(wallet.balanceCents, results[i].status === 201 ? 4250 : 5000);
  }
  const first = await f.DB.prepare("SELECT status FROM checkout_queue ORDER BY sequence LIMIT 1").first();
  assert.equal(first.status, "accepted");
});

test("tick boundary gates orders; concurrent processors respect database arrival order", async (t) => {
  const f = await fixture(t);
  const first = await f.enqueue(f.users[0], 200);
  await f.enqueue(f.users[1], 200);
  await settleTicks(f.DB, 199);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM orders").first()).n, 0);
  await Promise.all([settleTicks(f.DB, 200), settleTicks(f.DB, 200)]);
  assert.equal((await f.DB.prepare("SELECT request_key FROM orders").first()).request_key, first);
  assert.equal((await availableInventory(f.DB)).get("sandwich"), 0);
});

test("later ticks cannot overtake an earlier pending request", async (t) => {
  const f = await fixture(t);
  const first = await f.enqueue(f.users[0], 300);
  await f.enqueue(f.users[1], 200); // skewed worker clock must not change priority
  await settleTicks(f.DB, 200);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM orders").first()).n, 0);
  await settleTicks(f.DB, 300);
  assert.equal((await f.DB.prepare("SELECT request_key FROM orders").first()).request_key, first);
});

test("insufficient funds at the head does not consume stock or block the next buyer", async (t) => {
  const f = await fixture(t);
  await f.enqueue(f.users[0], 100, { total: 6000 });
  const winner = await f.enqueue(f.users[1], 100);
  await settleTicks(f.DB, 100);
  assert.equal((await f.DB.prepare("SELECT request_key FROM orders").first()).request_key, winner);
  assert.equal((await f.DB.prepare("SELECT status FROM checkout_queue ORDER BY sequence LIMIT 1").first()).status, "insufficient_funds");
});

test("a cart exceeding stock is rejected as a whole; unrelated stock stays available", async (t) => {
  const f = await fixture(t);
  const result = await f.purchase(f.users[0], crypto.randomUUID(), [
    { id: "sandwich", quantity: 2 }, { id: "coffee", quantity: 1 },
  ]);
  assert.equal(result.status, 409);
  assert.equal((await availableInventory(f.DB)).get("sandwich"), 1);
  assert.equal((await availableInventory(f.DB)).get("coffee"), 20);
  assert.equal((await f.purchase(f.users[1])).status, 201);
});

test("duplicate requests allocate once and cannot view another user's checkout", async (t) => {
  const f = await fixture(t), key = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.purchase(f.users[0], key)));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.ok(results.every((r) => r.status === 200 || r.status === 201));
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM order_items").first()).n, 1);
  assert.equal((await f.call(f.users[1], `/api/checkouts/${key}`)).status, 404);
  assert.equal((await f.purchase(f.users[1])).status, 409);
});

test("queue and inventory survive restart and processors using separate connections", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campus-inventory-"));
  const file = join(dir, "store.sqlite");
  const f = await fixture(t, file);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await f.enqueue(f.users[0], 200);
  await f.enqueue(f.users[1], 200);
  const second = openDatabase(file);
  try {
    await Promise.all([settleTicks(f.DB, 200), settleTicks(second, 200)]);
    await ensureInventory(second);
    assert.equal((await availableInventory(second)).get("sandwich"), 0);
    assert.equal((await second.prepare("SELECT request_key FROM orders").first()).request_key, first);
  } finally { second.close(); }
});

test("a failed allocation batch rolls back the order, funds, and queue outcome", async (t) => {
  const f = await fixture(t);
  await f.enqueue(f.users[0], 100);
  // Force a failure after the order INSERT to exercise transaction rollback.
  await f.DB.prepare(`CREATE TRIGGER fail_allocation BEFORE INSERT ON order_items
    BEGIN SELECT RAISE(ABORT, 'test failure'); END`).run();
  await assert.rejects(settleTicks(f.DB, 100));
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM orders").first()).n, 0);
  assert.equal((await f.DB.prepare("SELECT status FROM checkout_queue").first()).status, "pending");
  await f.DB.prepare("DROP TRIGGER fail_allocation").run();
  await settleTicks(f.DB, 100);
  assert.equal((await availableInventory(f.DB)).get("sandwich"), 0);
});
