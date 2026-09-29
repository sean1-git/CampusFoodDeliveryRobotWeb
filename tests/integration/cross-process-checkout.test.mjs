import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../../apps/api/src/database/local-db.mjs";
import { ensureInventory, availableInventory } from "../../apps/api/src/inventory/inventory.mjs";
import { studentSession } from "../fixtures/student-fixture.mjs";

const workerFile = fileURLToPath(new URL("../fixtures/cross-process-checkout-worker.mjs", import.meta.url));
const basket = { items: [{ id: "sandwich", quantity: 1 }],
  destination: { lat: 37.365562, lng: -120.424938, confirmed: true } };

function startWorker(filename) {
  const environment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  const child = spawn(process.execPath, [workerFile, filename], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"], env: environment,
  });
  const pending = new Map();
  let sequence = 0, output = "", bootResolve, bootReject, exited = false;
  const ready = new Promise((resolve, reject) => { bootResolve = resolve; bootReject = reject; });
  const bootTimer = setTimeout(() => bootReject(new Error(`Worker startup timed out: ${output}`)), 10000);
  function fail(error) {
    clearTimeout(bootTimer); bootReject(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  child.stderr.on("data", data => { output = (output + data).slice(-2000); });
  child.on("error", fail);
  child.on("message", message => {
    if (message.type === "ready") { clearTimeout(bootTimer); bootResolve(message.pid); return; }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  // Windows IPC can keep "close" pending after exit; stop() closes our pipe.
  const terminated = new Promise(resolve => child.once("exit", (code, signal) => {
    exited = true;
    fail(new Error(`Worker closed (${code ?? signal}): ${output}`));
    resolve();
  }));
  return {
    ready,
    request(type, fields = {}) {
      return new Promise((resolve, reject) => {
        if (exited || !child.connected) { reject(new Error("Worker is unavailable.")); return; }
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id); reject(new Error(`Worker command ${type} timed out: ${output}`));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, type, ...fields }, error => {
          if (!error || !pending.has(id)) return;
          clearTimeout(timer); pending.delete(id); reject(error);
        });
      });
    },
    async stop() {
      if (!exited && child.connected) child.disconnect();
      let deadline;
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await Promise.race([terminated, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Checkout worker did not terminate.")), 5000);
        })]);
      } finally {
        clearTimeout(force); clearTimeout(deadline);
        child.stderr.destroy(); child.unref();
      }
    },
  };
}

async function fixture(t, sameAccount = false) {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "campus-cross-process-"));
  const filename = join(directory, "store.sqlite"), workers = [];
  let db;
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.stop()));
    db?.close();
    const target = await realpath(directory);
    assert.equal(dirname(target), temporaryRoot, "Cleanup must stay inside the temporary directory");
    assert.ok(basename(target).startsWith("campus-cross-process-"));
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  db = openDatabase(filename);
  await ensureInventory(db);
  await db.prepare("UPDATE inventory SET quantity = 1 WHERE product_id = 'sandwich'").run();
  const users = [await studentSession(db, "first-student"),
    await studentSession(db, sameAccount ? "first-student" : "second-student")];
  db.close(); db = null;
  // Initialize sequentially, then stage both requests before releasing them.
  // This tests checkout contention separately from first-run schema migration.
  const pids = [];
  for (let i = 0; i < 2; i++) {
    const worker = startWorker(filename);
    workers.push(worker);
    pids.push(await worker.ready);
  }
  assert.equal(new Set(pids).size, 2, "Checkout requests must run in different OS processes");
  assert.ok(!pids.includes(process.pid));
  return { workers, users,
    inspect() { db ??= openDatabase(filename); return db; },
  };
}

async function recover(worker, operation, response) {
  for (let attempt = 0; attempt < 40; attempt++) {
    response ??= await worker.request("request", { operation });
    if (response.status !== 503 && response.status !== 202) return response;
    if (response.status === 503) assert.equal(response.busy, true, "Only a verified SQLite lock failure may be retried");
    // Retry the exact original request/key, including confirmation. A new key
    // would conceal duplicate-order bugs instead of exercising recovery.
    await delay(20 + attempt % 3 * 5);
    response = await worker.request("request", { operation });
  }
  assert.fail(`Checkout did not settle after bounded recovery (status ${response.status}).`);
}

async function compete(workers, operations) {
  await Promise.all(workers.map((worker, index) => worker.request("stage", { operation: operations[index] })));
  const startAt = Date.now() + 75;
  const first = await Promise.all(workers.map(worker => worker.request("go", { startAt })));
  return Promise.all(workers.map((worker, index) => recover(worker, operations[index], first[index])));
}

async function assertLedger(db, winnerId) {
  const orders = (await db.prepare("SELECT id, account_id, subtotal, total FROM orders").all()).results;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].account_id, winnerId);
  assert.equal(orders[0].subtotal, 650);
  assert.equal(orders[0].total, 750);
  const allocations = (await db.prepare("SELECT order_id, product_id, quantity FROM order_items").all()).results;
  assert.deepEqual(allocations.map(row => ({ ...row })), [{ order_id: orders[0].id, product_id: "sandwich", quantity: 1 }]);
  assert.equal((await availableInventory(db)).get("sandwich"), 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM checkout_queue WHERE status IN ('pending', 'held')").first()).count, 0);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  return orders[0].id;
}

test("two API processes competing for the last item keep one winner across retries", { timeout: 30000 }, async t => {
  const { workers, users, inspect } = await fixture(t);
  const operations = users.map(user => ({ user, key: crypto.randomUUID(), path: "/api/orders", body: basket }));
  const results = await compete(workers, operations);
  const winner = results.findIndex(result => result.status === 200 || result.status === 201);
  assert.notEqual(winner, -1);
  const loser = 1 - winner;
  assert.equal(results[loser].status, 409);
  assert.equal(results[loser].body.code, "sold_out");
  const orderId = await assertLedger(inspect(), users[winner].account_id);
  assert.equal(results[winner].body.id, orderId);
  // Read/replay through the other process to prove the committed state is shared.
  for (const index of [winner, loser]) {
    const worker = workers[1 - index];
    const replay = await recover(worker, operations[index]);
    if (index === winner) { assert.equal(replay.status, 200); assert.equal(replay.body.id, orderId); }
    else { assert.equal(replay.status, 409); assert.equal(replay.body.code, "sold_out"); }
    const session = await worker.request("request", { operation: { user: users[index], key: operations[index].key, path: "/api/session" } });
    assert.equal(session.status, 200);
    assert.equal(session.body.balanceCents, index === winner ? 4250 : 5000);
  }
  assert.equal(await assertLedger(inspect(), users[winner].account_id), orderId);
});

test("two API processes confirming one account's reservation charge and allocate once", { timeout: 30000 }, async t => {
  const { workers, users, inspect } = await fixture(t, true), key = crypto.randomUUID();
  const held = await recover(workers[0], { user: users[0], key, path: "/api/reservations", body: basket });
  assert.equal(held.status, 200);
  assert.equal(held.body.status, "held");
  const operations = users.map(user => ({ user, key, path: `/api/reservations/${key}/confirm`, body: {} }));
  const results = await compete(workers, operations);
  assert.ok(results.every(result => result.status === 201));
  const orderId = await assertLedger(inspect(), users[0].account_id);
  assert.ok(results.every(result => result.body.id === orderId));
  for (let index = 0; index < workers.length; index++) {
    const replay = await recover(workers[index], operations[index]);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, orderId);
    const session = await workers[index].request("request", { operation: { user: users[index], key, path: "/api/session" } });
    assert.equal(session.status, 200);
    assert.equal(session.body.balanceCents, 4250);
  }
  assert.equal(await assertLedger(inspect(), users[0].account_id), orderId);
});
