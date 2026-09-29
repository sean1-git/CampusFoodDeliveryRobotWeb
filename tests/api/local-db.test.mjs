import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../apps/api/src/database/local-db.mjs";

test("recurring bound queries prepare once and keep each request's arguments", async t => {
  const db = openDatabase(); t.after(() => db.close());
  const original = DatabaseSync.prototype.prepare;
  let preparations = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    preparations++;
    return original.call(this, sql);
  });
  const reads = Array.from({ length: 100 }, (_, value) => db.prepare("SELECT ? AS value").bind(value));
  const rows = await Promise.all(reads.map(query => query.first()));
  assert.deepEqual(rows.map(row => row.value), Array.from({ length: 100 }, (_, i) => i));
  assert.equal(preparations, 1);
  assert.equal((await reads[0].first()).value, 0);
  assert.equal((await reads[0].bind(101).first()).value, 101);
  assert.equal((await reads[0].first()).value, 0);
});

test("cached statements retain independent batch bindings and rollback atomically", async t => {
  const db = openDatabase(); t.after(() => db.close());
  const insert = "INSERT INTO inventory (product_id, quantity) VALUES (?, ?)";
  const first = db.prepare(insert).bind("first", 3);
  const second = db.prepare(insert).bind("second", 7);
  await db.batch([first, second]);
  const rows = (await db.prepare("SELECT product_id, quantity FROM inventory ORDER BY product_id").all()).results;
  assert.deepEqual(rows.map(row => [row.product_id, row.quantity]), [["first", 3], ["second", 7]]);
  await assert.rejects(db.batch([
    db.prepare(insert).bind("third", 9),
    db.prepare(insert).bind("first", 12),
  ]), /UNIQUE constraint failed/);
  assert.equal(await db.prepare("SELECT * FROM inventory WHERE product_id = ?").bind("third").first(), null);
  await db.prepare(insert).bind("fourth", 11).run();
  assert.equal((await db.prepare("SELECT quantity FROM inventory WHERE product_id = ?").bind("fourth").first()).quantity, 11);
});

test("statement cache evicts older SQL without invalidating outstanding wrappers", async t => {
  const db = openDatabase(); t.after(() => db.close());
  const original = DatabaseSync.prototype.prepare;
  let preparations = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    preparations++;
    return original.call(this, sql);
  });
  const oldest = db.prepare("SELECT ? AS oldest").bind(42);
  for (let i = 0; i < 128; i++) await db.prepare(`SELECT ${i} AS value`).first();
  assert.equal(preparations, 129);
  assert.equal((await oldest.first()).oldest, 42);
  await db.prepare("SELECT 127 AS value").first();
  assert.equal(preparations, 129);
  assert.equal((await db.prepare("SELECT ? AS oldest").bind(7).first()).oldest, 7);
  assert.equal(preparations, 130);
  assert.equal((await oldest.first()).oldest, 42);
});

test("prepared statements and new queries cannot outlive their database", async () => {
  const db = openDatabase(), read = db.prepare("SELECT 1 AS value");
  db.close();
  await assert.rejects(read.first());
  assert.throws(() => db.prepare("SELECT 1 AS value"));
});
