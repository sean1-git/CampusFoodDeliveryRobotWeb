/** Offline work-count probe. Uses only a disposable in-memory database. */
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../apps/api/src/database/local-db.mjs";
import { handleApi } from "../../apps/api/src/api.mjs";

const db = openDatabase();
const original = DatabaseSync.prototype.prepare;
let preparations = 0;
DatabaseSync.prototype.prepare = function (sql) {
  preparations++;
  return original.call(this, sql);
};

try {
  const started = performance.now();
  for (let i = 0; i < 5000; i++) {
    const row = await db.prepare("SELECT ? AS value").bind(i).first();
    if (row.value !== i) throw new Error("Bound query returned another request's value");
  }
  const boundReads = { requests: 5000, sqlitePreparations: preparations,
    elapsedMs: +(performance.now() - started).toFixed(2) };

  let seedAttempts = 0;
  const binding = { ...db, prepare(sql) {
    if (/^INSERT INTO inventory/.test(sql.trim())) seedAttempts++;
    return db.prepare(sql);
  } };
  preparations = 0;
  const catalogStarted = performance.now();
  for (let i = 0; i < 100; i++) {
    const response = await handleApi(new Request("https://campus.test/api/catalog"), { DB: binding });
    if (!response.ok || (await response.json()).products.length !== 12)
      throw new Error("Catalog request failed");
  }
  console.log(JSON.stringify({
    note: "Local in-memory microbenchmark; elapsed times do not predict deployed capacity.",
    node: process.version, boundReads,
    catalogReads: { requests: 100, seedAttempts, sqlitePreparations: preparations,
      elapsedMs: +(performance.now() - catalogStarted).toFixed(2) },
  }, null, 2));
} finally {
  DatabaseSync.prototype.prepare = original;
  db.close();
}
