import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "../../apps/api/src/database/local-db.mjs";
import { ensureInventory, availableInventory } from "../../apps/api/src/inventory/inventory.mjs";
import { handleApi } from "../../apps/api/src/api.mjs";
import { studentSession } from "../fixtures/student-fixture.mjs";

function countedBinding(db, failures = 0) {
  let writes = 0;
  return { get writes() { return writes; }, db: { ...db, prepare(sql) {
    if (!/^INSERT INTO inventory/.test(sql.trim())) return db.prepare(sql);
    return { bind: (...args) => ({ async run() {
      writes++;
      if (failures-- > 0) throw new Error("Temporary database failure");
      return db.prepare(sql).bind(...args).run();
    } }) };
  } } };
}

test("overlapping initialization and repeated catalog reads seed each binding once", async t => {
  const first = openDatabase(), second = openDatabase();
  t.after(() => { first.close(); second.close(); });
  const a = countedBinding(first), b = countedBinding(second);
  await Promise.all(Array.from({ length: 20 }, () => ensureInventory(a.db)));
  for (let i = 0; i < 5; i++) {
    const response = await handleApi(new Request("https://campus.test/api/catalog"), { DB: a.db });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).products.length, 12);
  }
  await ensureInventory(b.db);
  assert.equal(a.writes, 1);
  assert.equal(b.writes, 1);
});

test("a failed shared initialization rejects all waiters and the next request retries", async t => {
  const db = openDatabase(); t.after(() => db.close());
  const binding = countedBinding(db, 1);
  const failures = await Promise.allSettled(Array.from({ length: 8 }, () => ensureInventory(binding.db)));
  assert.ok(failures.every(result => result.status === "rejected"));
  assert.equal(binding.writes, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM inventory").first()).count, 0);
  await Promise.all([ensureInventory(binding.db), ensureInventory(binding.db)]);
  await ensureInventory(binding.db);
  assert.equal(binding.writes, 2);
  assert.equal((await availableInventory(db)).get("sandwich"), 20);
});

test("reopening a database seeds once for the new binding without restoring sold stock", async t => {
  const temporaryRoot = realpathSync(tmpdir()), directory = mkdtempSync(join(temporaryRoot, "campus-inventory-init-"));
  const filename = join(directory, "store.sqlite");
  let db = openDatabase(filename);
  t.after(() => {
    db.close();
    const target = realpathSync(directory);
    assert.equal(dirname(target), temporaryRoot);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const first = countedBinding(db), user = await studentSession(db);
  await ensureInventory(first.db);
  await db.prepare("UPDATE inventory SET quantity = 1 WHERE product_id = 'sandwich'").run();
  const response = await handleApi(new Request("https://campus.test/api/orders", {
    method: "POST", headers: { cookie: user.cookie, origin: "https://campus.test", "content-type": "application/json",
      "x-csrf-token": user.csrf, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ items: [{ id: "sandwich", quantity: 1 }],
      destination: { lat: 37.365562, lng: -120.424938, confirmed: true } }),
  }), { DB: first.db });
  assert.equal(response.status, 201);
  assert.equal((await availableInventory(db)).get("sandwich"), 0);
  await ensureInventory(first.db);
  assert.equal(first.writes, 1);
  db.close(); db = openDatabase(filename);
  const reopened = countedBinding(db);
  await Promise.all([ensureInventory(reopened.db), ensureInventory(reopened.db)]);
  assert.equal(reopened.writes, 1);
  assert.equal((await availableInventory(db)).get("sandwich"), 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM orders").first()).count, 1);
});
