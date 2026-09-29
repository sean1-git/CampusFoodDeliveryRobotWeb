// Test-only IPC worker: runs the real API against a disposable shared SQLite file.
import { basename, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../../apps/api/src/database/local-db.mjs";
import { ensureInventory } from "../../apps/api/src/inventory/inventory.mjs";
import { handleApi } from "../../apps/api/src/api.mjs";

const filename = process.argv[2];
if (!process.send || basename(filename ?? "") !== "store.sqlite"
  || !basename(dirname(filename)).startsWith("campus-cross-process-"))
  throw new Error("The checkout worker requires its disposable test database and IPC.");

const raw = openDatabase(filename);
let sawBusy = false;
function record(error) {
  if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error.code)
    || (error.code === "ERR_SQLITE_ERROR" && [5, 6].includes(error.errcode & 255))) sawBusy = true;
  throw error;
}
function observe(action) {
  try {
    const result = action();
    return typeof result?.then === "function" ? result.catch(record) : result;
  } catch (error) { return record(error); }
}
function statement(query) {
  return {
    bind: (...args) => statement(observe(() => query.bind(...args))),
    first: () => observe(() => query.first()),
    all: () => observe(() => query.all()),
    run: () => observe(() => query.run()),
    execute: () => observe(() => query.execute()),
  };
}
const DB = {
  prepare: sql => statement(observe(() => raw.prepare(sql))),
  batch: statements => observe(() => raw.batch(statements)),
};
await ensureInventory(DB);

function send(message) {
  if (process.connected) process.send(message, () => {});
}
async function call({ user, key, path, body }) {
  sawBusy = false;
  const response = await handleApi(new Request(`https://campus.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: user.cookie, origin: "https://campus.test", "content-type": "application/json",
      "x-csrf-token": user.csrf, "idempotency-key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { DB });
  return { status: response.status, body: await response.json(), busy: sawBusy };
}

let staged;
process.on("message", async message => {
  try {
    let result;
    if (message.type === "stage") {
      staged = message.operation;
      result = { staged: true };
    } else if (message.type === "go") {
      if (!staged) throw new Error("No request was staged before the start barrier.");
      const operation = staged;
      staged = undefined;
      await delay(Math.max(0, message.startAt - Date.now()));
      result = await call(operation);
    } else if (message.type === "request") result = await call(message.operation);
    else throw new Error("Unknown test worker command.");
    send({ id: message.id, result });
  } catch (error) { send({ id: message.id, error: error.message }); }
});
process.on("disconnect", () => { raw.close(); process.exit(0); });
send({ type: "ready", pid: process.pid });
