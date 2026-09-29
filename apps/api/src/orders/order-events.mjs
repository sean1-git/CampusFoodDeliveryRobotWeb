/**
 * Process-local SSE invalidations for the single-instance demo. Order state stays
 * in the database; reconnecting clients always fetch an authenticated snapshot.
 */
import { authenticatedSession, SESSION_AGE } from "../auth/auth.mjs";
import { publicOrder } from "./orders.mjs";
import { json } from "../http/http.mjs";

const encoder = new TextEncoder();
const eventBytes = (name) => encoder.encode(`event: ${name}\ndata: {}\n\n`);
const heartbeatBytes = eventBytes("heartbeat");
const MAX_TIMER_MS = 2 ** 31 - 1;

// Timers follow the saved order, including pickup pauses. They never recompute a
// route from the latest map or repeatedly poll the order table for elapsed time.
export function orderBoundaries(rows, now) {
  const boundaries = new Set();
  const add = (time) => { if (Number.isFinite(time) && time > now) boundaries.add(time); };
  for (const row of rows) {
    const order = publicOrder(row, now);
    add(order.departsAt);
    add(order.arrivesAt);
    for (const pickup of order.deliveryRoute?.pickups ?? []) {
      if (Number.isFinite(pickup.arrivalSeconds)) add(order.departsAt + pickup.arrivalSeconds * 1000);
      if (Number.isFinite(pickup.departureSeconds)) add(order.departsAt + pickup.departureSeconds * 1000);
    }
    for (const leg of order.deliveryRoute?.journey ?? []) {
      if (Number.isFinite(leg.startsAtSeconds)) {
        add(order.departsAt + leg.startsAtSeconds * 1000);
        if (Number.isFinite(leg.seconds)) add(order.departsAt + (leg.startsAtSeconds + leg.seconds) * 1000);
      }
    }
  }
  return [...boundaries].sort((a, b) => a - b);
}

export function createOrderEvents({ db, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  heartbeatMs = 25000, authCheckMs = 60000, lifetimeMs = 240000,
  maxPerAccount = 4, maxConnections = 32, bufferBytes = 1024 } = {}) {
  const accounts = new Map();
  let connections = 0, stopped = false;
  const later = (callback, delay) => {
    const timer = setTimer(callback, Math.max(1, Math.min(MAX_TIMER_MS, delay)));
    timer?.unref?.();
    return timer;
  };
  const live = (account) => accounts.get(account.id) === account && account.clients.size > 0;

  function scheduleBoundary(account) {
    clearTimer(account.timer);
    account.timer = null;
    if (!live(account) || !account.boundaries.length) return;
    account.timer = later(() => {
      if (!live(account)) return;
      const current = now();
      const crossed = account.boundaries.some(time => time <= current);
      account.boundaries = account.boundaries.filter(time => time > current);
      if (crossed) for (const client of [...account.clients]) client.send("change");
      scheduleBoundary(account);
    }, account.boundaries[0] - now());
  }

  function refreshBoundaries(account) {
    if (account.refreshing) { account.refreshAgain = true; return account.refreshing; }
    account.refreshing = (async () => {
      do {
        account.refreshAgain = false;
        const rows = await db.prepare("SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC LIMIT 50")
          .bind(account.id).all();
        if (!live(account)) return;
        account.boundaries = orderBoundaries(rows.results, now());
        scheduleBoundary(account);
      } while (account.refreshAgain);
    })().catch(() => {
      // A reconnect/snapshot can recover from database failures. Never report
      // an uncertain lookup as a revoked session or fail a completed purchase.
      for (const client of [...account.clients]) client.close();
    }).finally(() => { account.refreshing = null; });
    return account.refreshing;
  }

  function subscribe(request, session) {
    if (stopped) return json({ error: "Live updates are restarting." }, 503);
    if (request.signal.aborted) return json({ error: "Request cancelled." }, 499);
    let account = accounts.get(session.account_id);
    if (connections >= maxConnections || (account?.clients.size ?? 0) >= maxPerAccount)
      return json({ error: "Too many live update connections. Periodic refresh remains available." }, 429, { "Retry-After": "30" });
    if (!account) {
      account = { id: session.account_id, clients: new Set(), boundaries: [], timer: null, refreshing: null, refreshAgain: false };
      accounts.set(account.id, account);
    }
    let controller, closed = false, heartbeat, authTimer, expiry, lifetime;
    const expiresAt = session.created_at + SESSION_AGE;
    function close() {
      if (closed) return;
      closed = true;
      for (const timer of [heartbeat, authTimer, expiry, lifetime]) clearTimer(timer);
      request.signal.removeEventListener("abort", close);
      account.clients.delete(client);
      connections--;
      if (!account.clients.size) {
        clearTimer(account.timer);
        accounts.delete(account.id);
      }
      try { controller.close(); } catch { /* The reader may already be cancelled. */ }
    }
    function write(bytes) {
      if (closed) return false;
      // A slow tab cannot accumulate an unbounded queue of invalidations.
      if (controller.desiredSize < bytes.byteLength) { close(); return false; }
      try { controller.enqueue(bytes); return true; } catch { close(); return false; }
    }
    function expire() { write(eventBytes("session-expired")); close(); }
    function send(name) {
      if (closed) return;
      if (now() >= expiresAt) { expire(); return; }
      write(eventBytes(name));
    }
    const client = { close, send };
    async function validateSession() {
      if (closed) return;
      try {
        const active = await authenticatedSession(request, db, now(), true);
        if (closed) return;
        if (!active || active.id !== session.id || active.account_id !== session.account_id) { expire(); return; }
        authTimer = later(validateSession, authCheckMs);
      } catch { close(); }
    }
    function beat() {
      if (closed) return;
      if (now() >= expiresAt) { expire(); return; }
      if (write(heartbeatBytes)) heartbeat = later(beat, heartbeatMs);
    }
    const stream = new ReadableStream({
      start(sink) {
        controller = sink;
        connections++;
        account.clients.add(client);
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) { close(); return; }
        send("ready");
        if (closed) return;
        heartbeat = later(beat, heartbeatMs);
        authTimer = later(validateSession, authCheckMs);
        expiry = later(expire, expiresAt - now());
        lifetime = later(close, lifetimeMs);
        // Additional tabs share the account's loaded boundaries and one timer.
        if (account.clients.size === 1) void refreshBoundaries(account);
      },
      cancel: close,
    }, { highWaterMark: bufferBytes, size: chunk => chunk.byteLength });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    } });
  }

  return {
    subscribe,
    async publish(accountId) {
      const account = accounts.get(accountId);
      if (!account) return;
      for (const client of [...account.clients]) client.send("change");
      if (live(account)) await refreshBoundaries(account);
    },
    close() {
      stopped = true;
      for (const account of [...accounts.values()]) for (const client of [...account.clients]) client.close();
    },
  };
}
