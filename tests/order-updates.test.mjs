import test from "node:test";
import assert from "node:assert/strict";
import { createOrderUpdates } from "../src/lib/orderUpdates.ts";

function harness({ native = false, random = () => 0.5, connectThrows = false, refresh } = {}) {
  let now = 0, nextId = 0;
  const jobs = new Map(), delays = [], streams = [], refreshes = [], reconciles = [], expired = [];
  const timer = (callback, delay) => {
    const id = ++nextId;
    delays.push(delay);
    jobs.set(id, { at: now + delay, callback });
    return () => jobs.delete(id);
  };
  const advance = milliseconds => {
    const end = now + milliseconds;
    for (;;) {
      const next = [...jobs].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      now = next[1].at; jobs.delete(next[0]); next[1].callback();
    }
    now = end;
  };
  let attempts = 0;
  const connect = () => {
    attempts++;
    if (connectThrows) throw new Error("EventSource blocked");
    const listeners = new Map();
    const stream = {
      closed: false,
      addEventListener(type, listener) { listeners.set(type, listener); },
      close() { this.closed = true; },
      // Intentionally deliver queued events after close to exercise stale guards.
      emit(type) { listeners.get(type)?.(); },
    };
    streams.push(stream);
    return stream;
  };
  const updates = createOrderUpdates({ connect: native ? undefined : connect, timer, random,
    refresh: invalidate => { refreshes.push({ at: now, invalidate }); return refresh?.(invalidate); },
    reconcileCheckout: () => reconciles.push(now), sessionExpired: () => expired.push(now),
  });
  let state = { sessionKey: "account-a", online: true, visible: true, activeOrders: false, checkout: false };
  const update = patch => { state = { ...state, ...patch }; updates.update(state); };
  const advanceHealthy = milliseconds => {
    while (milliseconds >= 25000) { advance(25000); streams.at(-1).emit("heartbeat"); milliseconds -= 25000; }
    advance(milliseconds);
  };
  return { updates, update, advance, advanceHealthy, streams, refreshes, reconciles, expired, jobs, delays,
    get attempts() { return attempts; } };
}

test("healthy SSE takes one snapshot, then invalidations replace idle and active polling", () => {
  const host = harness();
  host.update({}); host.streams[0].emit("ready");
  host.advanceHealthy(10 * 60000);
  assert.deepEqual(host.refreshes, [{ at: 0, invalidate: true }]);
  assert.equal(host.jobs.size, 1, "only the liveness watchdog remains");
  host.update({ activeOrders: true });
  host.advanceHealthy(60000);
  assert.equal(host.refreshes.length, 1);
  host.streams[0].emit("change");
  assert.equal(host.refreshes.length, 2);
  assert.equal(host.refreshes[1].invalidate, true);
  host.update({});
  assert.equal(host.streams.length, 1, "new state objects do not reopen the stream");
});

test("checkout recovery remains every five seconds on a healthy stream", () => {
  const host = harness();
  host.update({ checkout: true }); host.streams[0].emit("ready");
  host.advance(15000);
  assert.deepEqual(host.reconciles, [5000, 10000, 15000]);
  assert.equal(host.refreshes.length, 1);
  host.update({ checkout: false }); host.advance(30000);
  assert.equal(host.reconciles.length, 3);
});

test("hidden and offline pause both transports and checkout recovery; resume snapshots again", () => {
  const host = harness();
  host.update({ checkout: true }); host.streams[0].emit("ready");
  for (const pause of [{ visible: false }, { online: false }]) {
    const old = host.streams.at(-1), reads = host.refreshes.length;
    host.update(pause); host.advance(120000);
    old.emit("change"); old.emit("error"); old.emit("ready");
    assert.equal(old.closed, true);
    assert.equal(host.jobs.size, 0);
    assert.equal(host.refreshes.length, reads);
    assert.equal(host.reconciles.length, 0);
    host.update({ visible: true, online: true });
    host.streams.at(-1).emit("ready");
    assert.equal(host.refreshes.length, reads + 1);
  }
});

test("errors close browser retry, back off with bounded jitter, and continue fallback polling", () => {
  for (const random of [() => 0, () => 1]) {
    const host = harness({ random });
    host.update({ activeOrders: true });
    let priorDelay = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      const stream = host.streams.at(-1), count = host.streams.length;
      stream.emit("error");
      const delay = host.delays.at(-1);
      assert.ok(delay >= 1500 && delay <= 60000);
      assert.ok(delay >= priorDelay);
      priorDelay = delay;
      assert.equal(stream.closed, true);
      host.advance(delay - 1);
      assert.equal(host.streams.length, count);
      host.advance(1);
      assert.equal(host.streams.length, count + 1);
    }
    assert.ok(host.refreshes.some(read => !read.invalidate), "fallback snapshots continue during failures");
    const count = host.refreshes.length;
    host.streams.at(-1).emit("ready"); host.advanceHealthy(120000);
    assert.equal(host.refreshes.length, count + 1, "fallback stops after reconnect snapshot");
    host.updates.stop(); assert.equal(host.jobs.size, 0);
  }
});

test("a stalled open stream times out, but heartbeats never fetch a snapshot", () => {
  const host = harness();
  host.update({}); host.streams[0].emit("ready");
  host.advanceHealthy(600000);
  assert.equal(host.refreshes.length, 1); assert.equal(host.streams.length, 1);
  host.advance(69999); assert.equal(host.streams[0].closed, false);
  host.advance(1); assert.equal(host.streams[0].closed, true);
  host.advance(2000); assert.equal(host.streams.length, 2);
  host.streams[1].emit("ready");
  assert.equal(host.refreshes.length, 2);
});

test("a failed final-event snapshot retries without a new event, then stays idle", async () => {
  let failed = false;
  const host = harness({ refresh: () => failed ? Promise.reject(new Error("network interrupted")) : Promise.resolve() });
  host.update({}); host.streams[0].emit("ready"); await Promise.resolve();
  failed = true; host.streams[0].emit("change"); await Promise.resolve();
  host.advance(1999); assert.equal(host.refreshes.length, 2);
  failed = false; host.advance(1); await Promise.resolve();
  assert.equal(host.refreshes.length, 3);
  host.advanceHealthy(120000);
  assert.equal(host.refreshes.length, 3);
});

test("snapshot retries coalesce, back off, and discard failures from hidden/replaced sessions", async () => {
  let reject;
  const host = harness({ refresh: () => new Promise((resolve, fail) => { reject = fail; }) });
  host.update({}); host.streams[0].emit("ready");
  const stale = reject;
  host.update({ sessionKey: "account-b" }); host.streams[1].emit("ready");
  stale(new Error("old account read")); await Promise.resolve();
  host.advance(2000); assert.equal(host.refreshes.length, 2);
  reject(new Error("read failed")); await Promise.resolve();
  host.advance(2000); assert.equal(host.refreshes.length, 3);
  reject(new Error("read failed again")); await Promise.resolve();
  host.advance(3999); assert.equal(host.refreshes.length, 3);
  host.update({ visible: false }); host.advance(60000);
  assert.equal(host.jobs.size, 0); assert.equal(host.refreshes.length, 3);
});

test("failed expired-session bootstrap retries without a session, pausing while hidden", async () => {
  let fail = false;
  const host = harness({ refresh: () => fail ? Promise.reject(new Error("temporary outage")) : Promise.resolve() });
  host.update({}); host.streams[0].emit("ready"); await Promise.resolve();
  fail = true;
  host.streams[0].emit("session-expired");
  host.update({ sessionKey: null }); // React commits the cleared account.
  await Promise.resolve();
  assert.equal(host.expired.length, 1);
  host.advance(2000); await Promise.resolve();
  assert.equal(host.refreshes.length, 3);
  host.update({ visible: false }); host.advance(60000);
  assert.equal(host.refreshes.length, 3); assert.equal(host.jobs.size, 0);
  fail = false;
  host.update({ visible: true }); await Promise.resolve();
  assert.equal(host.refreshes.length, 4);
  host.update({ sessionKey: "renewed-account" }); host.streams[1].emit("ready"); await Promise.resolve();
  host.advanceHealthy(120000);
  assert.equal(host.refreshes.length, 5);
});

test("native and unavailable EventSource keep active/idle polling, paused while hidden", () => {
  const host = harness({ native: true });
  host.update({}); host.advance(60000);
  assert.deepEqual(host.refreshes.map(read => read.at), [30000, 60000]);
  host.update({ activeOrders: true, checkout: true }); host.advance(10000);
  assert.deepEqual(host.refreshes.slice(2).map(read => read.at), [65000, 70000]);
  assert.deepEqual(host.reconciles, [65000, 70000]);
  host.update({ visible: false }); host.advance(60000);
  assert.equal(host.refreshes.length, 4); assert.equal(host.reconciles.length, 2);
  assert.equal(host.attempts, 0);
});

test("a connection without ready times out and blocked construction cannot cause a tight loop", () => {
  const silent = harness();
  silent.update({}); silent.advance(15000);
  assert.equal(silent.streams[0].closed, true);
  silent.advance(1999); assert.equal(silent.streams.length, 1);
  silent.advance(1); assert.equal(silent.streams.length, 2);
  const blocked = harness({ connectThrows: true });
  blocked.update({}); blocked.advance(60000);
  assert.equal(blocked.attempts, 5);
  assert.equal(blocked.refreshes.length, 2);
  blocked.updates.stop(); assert.equal(blocked.jobs.size, 0);
});

test("session expiry clears account display once and old streams cannot affect replacement sessions", () => {
  const host = harness();
  host.update({}); const first = host.streams[0]; first.emit("ready");
  first.emit("session-expired");
  assert.equal(host.expired.length, 1); assert.equal(first.closed, true);
  assert.equal(host.refreshes.length, 2);
  first.emit("change"); first.emit("session-expired"); host.advance(120000);
  assert.equal(host.refreshes.length, 2); assert.equal(host.jobs.size, 0);
  host.update({ sessionKey: "account-b" });
  host.streams[1].emit("ready"); first.emit("change"); first.emit("error");
  assert.equal(host.refreshes.length, 3);
  host.updates.resetSession();
  host.streams[1].emit("change");
  assert.equal(host.refreshes.length, 3); assert.equal(host.jobs.size, 0);
  host.update({ sessionKey: "account-c" }); host.streams[2].emit("ready");
  host.updates.stop(); host.streams[2].emit("change"); host.advance(120000);
  assert.equal(host.refreshes.length, 4); assert.equal(host.jobs.size, 0);
});
