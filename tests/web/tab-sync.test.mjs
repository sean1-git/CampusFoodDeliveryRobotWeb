import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createRefreshQueue } from "../../apps/web/src/shared/state/refreshQueue.ts";

const busCode = ts.transpileModule(readFileSync(new URL("../../apps/web/src/shared/state/tabSync.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Separate module contexts represent tabs; both transport paths deliver each
// event so duplicate delivery and fallback behavior are exercised explicitly.
function browser({ channel = true, storage = true, brokenChannel = false } = {}) {
  const tabs = [];
  function newTab() {
    const target = new EventTarget();
    const channels = [];
    const messages = [];
    const exports = {};
    const tab = { target, channels, messages, exports };
    class Channel extends EventTarget {
      constructor() {
        super();
        if (brokenChannel) throw new Error("Channel blocked");
        channels.push(this);
      }
      postMessage(data) {
        for (const other of tabs) if (other !== tab) {
          for (const peer of other.channels) peer.dispatchEvent(new MessageEvent("message", { data }));
        }
      }
    }
    const localStorage = { setItem(key, value) {
      if (!storage) throw new Error("Storage blocked");
      messages.push(JSON.parse(value));
      for (const other of tabs) if (other !== tab) {
        const event = new Event("storage");
        Object.assign(event, { key, newValue: value });
        other.target.dispatchEvent(event);
      }
    } };
    runInNewContext(busCode, { exports, crypto, window: target, localStorage,
      BroadcastChannel: channel ? Channel : undefined, MessageEvent });
    tabs.push(tab);
    return tab;
  }
  return { newTab };
}

for (const options of [ {}, { channel: false }, { storage: false }, { brokenChannel: true } ]) {
  test(`order/session invalidation reaches another tab once: ${JSON.stringify(options)}`, () => {
    const host = browser(options), a = host.newTab(), b = host.newTab();
    const own = [], received = [];
    a.exports.subscribeTabEvents((type) => own.push(type));
    const stop = b.exports.subscribeTabEvents((type) => received.push(type));
    a.exports.publishTabEvent("orders");
    a.exports.publishTabEvent("session");
    assert.deepEqual(received, ["orders", "session"]);
    assert.deepEqual(own, []);
    stop();
    a.exports.publishTabEvent("orders");
    assert.equal(received.length, 2);
    for (const message of a.messages) {
      assert.deepEqual(Object.keys(message).sort(), ["id", "sender", "type"]);
    }
  });
}

test("tab bus ignores malformed and replayed messages", () => {
  const { newTab } = browser();
  const tab = newTab(), received = [];
  tab.exports.subscribeTabEvents((type) => received.push(type));
  const send = (newValue) => {
    const event = new Event("storage");
    Object.assign(event, { key: "campus-store-tab-event", newValue });
    tab.target.dispatchEvent(event);
  };
  for (const value of ["{", "null", "{}", JSON.stringify({ type: "unknown", sender: "other", id: "1" })]) send(value);
  const valid = JSON.stringify({ type: "orders", sender: "other", id: "2" });
  send(valid);
  send(valid);
  assert.deepEqual(received, ["orders"]);
});

test("an order event during an old refresh eventually applies the new wallet, orders and cooldown", async () => {
  let server = { balance: 5000, orders: [], nextOrderAt: null };
  let displayed, release;
  let calls = 0;
  const refresh = createRefreshQueue(async () => {
    const snapshot = structuredClone(server);
    if (++calls === 1) await new Promise((resolve) => { release = resolve; });
    displayed = snapshot;
  });
  const beforeOrder = refresh();
  server = { balance: 4250, orders: ["order-uuid"], nextOrderAt: 3600000 };
  const afterOrder = refresh();
  refresh();
  release();
  await Promise.all([beforeOrder, afterOrder]);
  assert.deepEqual(displayed, server);
  assert.equal(calls, 2);
});

test("a failed account refresh can recover on the next event or wake", async () => {
  let fail = true;
  const refresh = createRefreshQueue(async () => {
    if (fail) throw new Error("offline");
  });
  await assert.rejects(refresh(), /offline/);
  fail = false;
  await refresh();
});


test("startup and wake share an in-flight read but an order invalidation still reruns it", async () => {
  let release, calls = 0;
  const refresh = createRefreshQueue(async () => {
    if (++calls === 1) await new Promise(resolve => { release = resolve; });
  });
  const startup = refresh(false);
  assert.equal(refresh(false), startup);
  assert.equal(refresh(false), startup);
  release();
  await startup;
  assert.equal(calls, 1);
  await refresh();
  assert.equal(calls, 2);
});
