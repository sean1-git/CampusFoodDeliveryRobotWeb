import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../server/local-db.mjs";
import { handleApi } from "../server/api.mjs";
import { issueStudentSession, SESSION_AGE } from "../server/auth.mjs";
import { ORDER_COOLDOWN_MS, availableInventory } from "../server/inventory.mjs";
import { studentSession } from "./student-fixture.mjs";

const origin = "https://campus.test";
const basket = { items: [{ id: "sandwich", quantity: 1 }], location: "Library entrance" };
async function call(DB, user, path, { method = "GET", body, key = crypto.randomUUID(), now = Date.now(), headers = {} } = {}) {
  const response = await handleApi(new Request(origin + path, {
    method, headers: { origin, cookie: user?.cookie ?? "", "x-csrf-token": user?.csrf ?? "",
      "content-type": "application/json", "idempotency-key": key, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { DB }, now);
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function submit(DB, user, path = "/api/orders", key = crypto.randomUUID()) {
  let result = await call(DB, user, path, { method: "POST", body: basket, key });
  for (let i = 0; result.status === 202 && i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await call(DB, user, `/api/checkouts/${key}`);
  }
  return { ...result, key };
}
async function fixture(t) {
  const DB = openDatabase();
  t.after(() => DB.close());
  const a = await studentSession(DB, "student-a");
  const b = await studentSession(DB, "student-a");
  const other = await studentSession(DB, "student-b");
  return { DB, a, b, other };
}

test("separate browsers and replacement cookies share the account, wallet, orders, and cooldown", async (t) => {
  const { DB, a, b, other } = await fixture(t);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.csrf, b.csrf);
  assert.equal(a.account_id, b.account_id);
  const first = await submit(DB, a);
  assert.equal(first.status, 201);
  const replacement = await studentSession(DB, "student-a");
  for (const user of [b, replacement]) {
    const state = (await call(DB, user, "/api/session")).body;
    assert.equal(state.balanceCents, 4250);
    assert.equal(state.nextOrderAt, first.body.createdAt + ORDER_COOLDOWN_MS);
    assert.equal(state.accountId, a.account_id);
    assert.equal((await call(DB, user, "/api/orders")).body.orders[0].id, first.body.id);
    assert.equal((await submit(DB, user)).body.code, "order_cooldown");
  }
  assert.equal((await submit(DB, other)).status, 201);
  assert.equal((await call(DB, other, `/api/orders/${first.body.id}`)).status, 404);
});

test("one pending checkout per account covers both reservation and direct purchase endpoints", async (t) => {
  const { DB, a, b, other } = await fixture(t);
  const hold = await submit(DB, a, "/api/reservations");
  assert.equal(hold.body.status, "held");
  for (const path of ["/api/orders", "/api/reservations"]) {
    assert.equal((await submit(DB, b, path)).body.code, "active_reservation");
  }
  assert.equal((await call(DB, other, `/api/checkouts/${hold.key}`)).status, 404);
  assert.equal((await call(DB, other, `/api/reservations/${hold.key}/confirm`, { method: "POST" })).status, 404);
  const confirmed = await call(DB, b, `/api/reservations/${hold.key}/confirm`, { method: "POST" });
  assert.equal(confirmed.status, 201);
  assert.equal((await submit(DB, a)).body.code, "order_cooldown");
});

test("cross-browser retries and racing confirmations charge once without extending cooldown", async (t) => {
  const { DB, a, b } = await fixture(t);
  const hold = await submit(DB, a, "/api/reservations");
  const outcomes = await Promise.all([a, b, a, b].map((user) =>
    call(DB, user, `/api/reservations/${hold.key}/confirm`, { method: "POST" })));
  assert.ok(outcomes.every((r) => r.status === 201));
  assert.equal(new Set(outcomes.map((r) => r.body.id)).size, 1);
  const cooldown = (await call(DB, b, "/api/session")).body.nextOrderAt;
  const retry = await submit(DB, b, "/api/orders", hold.key);
  assert.equal(retry.body.id, outcomes[0].body.id);
  assert.equal((await call(DB, b, "/api/session")).body.nextOrderAt, cooldown);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM order_items").first()).n, 1);
  assert.equal((await call(DB, a, "/api/session")).body.balanceCents, 4250);
});

test("simultaneous new orders in separate sessions have one winner", async (t) => {
  const { DB, a, b } = await fixture(t);
  const results = await Promise.all([submit(DB, a), submit(DB, b)]);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM orders").first()).n, 1);
});

test("cooldown expires at the exact server deadline and ignores client identity/time/cooldown claims", async (t) => {
  const { DB, a, b, other } = await fixture(t);
  const first = await submit(DB, a);
  const deadline = first.body.createdAt + ORDER_COOLDOWN_MS;
  const denied = await call(DB, b, "/api/orders", {
    method: "POST", now: deadline - 1,
    body: { ...basket, accountId: other.account_id, cooldown_until: 0, current_time: deadline + 1 },
    headers: { "x-student-id": "different-student", "x-account-id": other.account_id },
  });
  assert.equal(denied.body.code, "order_cooldown");
  assert.equal(denied.body.retryAt, deadline);
  const key = crypto.randomUUID();
  const pending = await call(DB, b, "/api/orders", { method: "POST", body: basket, key, now: deadline });
  assert.equal(pending.status, 202);
  const accepted = await call(DB, b, `/api/checkouts/${key}`, { now: deadline + 100 });
  assert.equal(accepted.status, 201);
  assert.equal((await call(DB, a, "/api/session")).body.nextOrderAt, accepted.body.createdAt + ORDER_COOLDOWN_MS);
});

test("demo bootstrap does not authenticate client student claims or revive expired and legacy sessions", async (t) => {
  const { DB, a } = await fixture(t);
  const anonymous = await call(DB, null, "/api/session");
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.headers.has("set-cookie"), true);
  assert.equal((await call(DB, null, "/api/orders", { method: "POST", body: { ...basket, studentId: "student-a" },
    headers: { "x-student-id": "student-a" } })).status, 401);
  const expired = await studentSession(DB, "student-a", Date.now() - SESSION_AGE - 100);
  assert.equal((await call(DB, expired, "/api/orders", { method: "POST", body: basket })).status, 401);
  await DB.prepare("UPDATE accounts SET kind = 'legacy' WHERE id = ?").bind(a.account_id).run();
  assert.equal((await call(DB, a, "/api/orders")).status, 401);
});

test("SSO account mapping includes issuer and keeps cooldown out of the cookie", async (t) => {
  const { DB, a } = await fixture(t);
  const separateIssuer = await issueStudentSession(DB, { issuer: "https://another-school.test", subject: "student-a" });
  assert.notEqual(separateIssuer.account_id, a.account_id);
  assert.match(separateIssuer.cookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.doesNotMatch(separateIssuer.cookie, /cooldown|subject|student-a|account_id/);
});

test("expired pending reservations release the account slot; cancellation does not start cooldown", async (t) => {
  const { DB, a, b } = await fixture(t);
  const held = await submit(DB, a, "/api/reservations");
  await DB.prepare("UPDATE checkout_queue SET status = 'pending', expires_at = 1 WHERE request_key = ?").bind(held.key).run();
  const next = await submit(DB, b, "/api/reservations");
  assert.equal(next.body.status, "held");
  assert.equal((await call(DB, a, `/api/reservations/${next.key}/cancel`, { method: "POST" })).body.status, "cancelled");
  assert.equal((await call(DB, b, "/api/session")).body.nextOrderAt, null);
});

test("failed order allocation rolls back both cooldown and funds", async (t) => {
  const { DB, a, b } = await fixture(t);
  const hold = await submit(DB, a, "/api/reservations");
  await DB.prepare("CREATE TRIGGER account_test_failure BEFORE INSERT ON order_items BEGIN SELECT RAISE(ABORT, 'allocation failed'); END").run();
  const failed = await call(DB, b, `/api/reservations/${hold.key}/confirm`, { method: "POST" });
  assert.equal(failed.status, 503);
  assert.equal((await DB.prepare("SELECT cooldown_until FROM accounts WHERE id = ?").bind(a.account_id).first()).cooldown_until, 0);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM orders").first()).n, 0);
  assert.equal((await call(DB, a, "/api/session")).body.balanceCents, 5000);
  await DB.prepare("DROP TRIGGER account_test_failure").run();
  assert.equal((await call(DB, b, `/api/reservations/${hold.key}/confirm`, { method: "POST" })).status, 201);
});

test("cooldown survives database restart and rejects a competing write on another connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "campus-account-test-"));
  const file = join(directory, "test.sqlite");
  let db = openDatabase(file), second;
  try {
    const a = await studentSession(db, "shared-student");
    const first = await submit(db, a);
    second = openDatabase(file);
    const b = await studentSession(second, "shared-student");
    const duplicateWrite = () => second.prepare(`INSERT INTO orders
      (id, session_id, account_id, request_key, request_hash, items, subtotal, total, location, created_at)
      VALUES (?, ?, ?, ?, 'test', '[]', 1, 1, 'Library entrance', ?)`)
      .bind(crypto.randomUUID(), b.id, b.account_id, crypto.randomUUID(), first.body.createdAt + 1).run();
    await assert.rejects(duplicateWrite, /account_order_cooldown/);
    db.close(); db = openDatabase(file);
    assert.equal((await submit(db, b)).body.code, "order_cooldown");
    assert.equal((await availableInventory(db)).get("sandwich"), 19);
    assert.equal((await call(db, b, "/api/session")).body.nextOrderAt, first.body.createdAt + ORDER_COOLDOWN_MS);
  } finally {
    second?.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent checkouts on separate database connections still have one account-level winner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "campus-account-race-test-"));
  const file = join(directory, "test.sqlite");
  const first = openDatabase(file);
  let second;
  try {
    second = openDatabase(file);
    const a = await studentSession(first, "same-student");
    const b = await studentSession(second, "same-student");
    const results = await Promise.all([submit(first, a), submit(second, b)]);
    assert.equal(results.filter((result) => result.status === 201).length, 1);
    assert.equal(results.filter((result) => result.status === 409).length, 1);
    assert.equal((await first.prepare("SELECT COUNT(*) n FROM orders").first()).n, 1);
    assert.equal((await availableInventory(second)).get("sandwich"), 19);
    assert.deepEqual((await call(first, a, "/api/session")).body.nextOrderAt,
      (await call(second, b, "/api/session")).body.nextOrderAt);
    assert.equal((await call(second, b, "/api/session")).body.balanceCents, 4250);
  } finally {
    second?.close(); first.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("replaying a cooldown-rejected queue entry never manufactures a new deadline", async (t) => {
  const { DB, a, b } = await fixture(t);
  const order = await submit(DB, a);
  const key = crypto.randomUUID();
  // Model an entry queued before a competing order's transaction committed.
  await DB.prepare(`INSERT INTO checkout_queue
    (order_id, session_id, account_id, request_key, request_hash, items, subtotal, total, location, ready_at, kind, expires_at)
    SELECT ?, session_id, account_id, ?, request_hash, items, subtotal, total, location, 0, kind, expires_at
    FROM checkout_queue WHERE request_key = ?`)
    .bind(crypto.randomUUID(), key, order.key).run();
  const deadline = order.body.createdAt + ORDER_COOLDOWN_MS;
  const rejected = await call(DB, b, `/api/checkouts/${key}`);
  assert.equal(rejected.body.code, "order_cooldown");
  assert.equal(rejected.body.retryAt, deadline);
  const lateRetry = await call(DB, b, `/api/checkouts/${key}`, { now: deadline + 1000 });
  assert.equal(lateRetry.body.retryAt, deadline);
  assert.equal((await call(DB, a, "/api/session")).body.nextOrderAt, deadline);
});

test("account migration preserves legacy history and cooldown without authenticating anonymous users", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../drizzle/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < "0005").sort()) {
      db.exec(readFileSync(new URL(file, directory), "utf8"));
    }
    db.exec(`INSERT INTO sessions VALUES ('legacy-session', 'csrf', 100);
      INSERT INTO orders VALUES ('legacy-order', 'legacy-session', 'key', 'hash', '[]', 200, 300, 'Library entrance', 1000);`);
    db.exec(readFileSync(new URL("0005_student_accounts.sql", directory), "utf8"));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM orders").get().n, 1);
    const account = db.prepare("SELECT * FROM accounts").get();
    assert.equal(account.kind, "legacy");
    assert.equal(account.cooldown_until, 1000 + ORDER_COOLDOWN_MS);
    assert.equal(db.prepare("SELECT account_id FROM orders").get().account_id, account.id);
  } finally { db.close(); }
});
