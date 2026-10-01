import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import sample from "../../packages/domain/src/catalog/catalog.json" with { type: "json" };

const root = fileURLToPath(new URL("../../", import.meta.url));
const web = resolve(root, "apps/web/src");
const catalog = (stock = 20) => ({ ...structuredClone(sample), products: sample.products.map(product => ({ ...product, stock })) });
const hold = (key = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") => ({
  key, phase: "held", expiresAt: 1300000, clockOffsetMs: 0,
  body: { items: [{ id: "sandwich", quantity: 1 }], location: "Campus walkway", destination: { lat: 37.363352, lng: -120.429973, confirmed: true } },
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Execute the real hook modules with deterministic hook lifecycles, browser events,
// storage and time. Only React scheduling, network transport, SSE and the tab bus
// are replaced; cache validation, refresh queues and checkout logic remain real.
function browser({ inventoryOnly = false, hidden = false, online = true, reservation, snapshot, request, locks, sharedValues } = {}) {
  const state = [], effects = [], modules = new Map(), jobs = new Map(), values = new Map(), tabListeners = new Set();
  let cursor = 0, dirty = false, result, now = 1000000, nextTimer = 0, controller;
  const calls = [], publishes = [];
  const window = new EventTarget(), document = new EventTarget();
  document.visibilityState = hidden ? "hidden" : "visible";
  const navigator = { onLine: online, locks };
  const backing = sharedValues ?? values;
  const localStorage = { getItem: key => backing.get(key) ?? null, setItem: (key, value) => backing.set(key, value), removeItem: key => backing.delete(key) };
  if (reservation) localStorage.setItem("campus-checkout-hold", JSON.stringify(reservation));
  if (snapshot) localStorage.setItem("campus-inventory-v1", JSON.stringify(snapshot));
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      state[index] ??= { value: typeof initial === "function" ? initial() : initial };
      state[index].set ??= value => {
        const next = typeof value === "function" ? value(state[index].value) : value;
        if (!Object.is(next, state[index].value)) { state[index].value = next; dirty = true; }
      };
      return [state[index].value, state[index].set];
    },
    useRef(current) { const index = cursor++; return state[index] ??= { current }; },
    useMemo(create, deps) {
      const index = cursor++;
      if (!equal(state[index]?.deps, deps)) state[index] = { value: create(), deps };
      return state[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(setup, deps) {
      const index = cursor++;
      if (!equal(state[index]?.deps, deps)) effects.push(() => {
        state[index]?.cleanup?.();
        state[index] = { deps, cleanup: setup() };
      });
    },
  };
  const setTimer = (callback, delay, interval = false) => {
    const id = ++nextTimer;
    jobs.set(id, { callback, at: now + delay, interval: interval ? delay : 0 });
    return id;
  };
  class Clock extends Date { static now() { return now; } }
  const globals = { window, document, navigator, localStorage, crypto, Date: Clock,
    setTimeout: (callback, delay) => setTimer(callback, delay), clearTimeout: id => jobs.delete(id),
    setInterval: (callback, delay) => setTimer(callback, delay, true), clearInterval: id => jobs.delete(id) };
  const api = { requestJson(path, options) {
    calls.push({ path, options });
    if (request) { const answer = request(path, options); if (answer !== undefined) return Promise.resolve(answer); }
    if (path.startsWith("/api/session")) return Promise.resolve({ csrf: "account-a", accountId: "account-a", balanceCents: 5000, nextOrderAt: null, serverNow: now, orders: [] });
    if (path === "/api/catalog") return Promise.resolve(catalog());
    if (path.startsWith("/api/checkouts/")) return Promise.resolve({ status: "held", serverNow: now, expiresAt: now + 300000 });
    throw new Error(`Unexpected test request: ${path}`);
  } };
  const replacements = new Map([
    [resolve(web, "shared/api/api.ts"), api],
    [resolve(web, "shared/state/tabSync.ts"), {
      publishTabEvent: type => publishes.push(type),
      subscribeTabEvents: listener => { tabListeners.add(listener); return () => tabListeners.delete(listener); },
    }],
    [resolve(web, "features/orders/orderUpdates.ts"), { createOrderUpdates(options) {
      controller = options; return { update() {}, resetSession() {}, stop() {} };
    } }],
  ]);
  function load(path) {
    if (path === "react") return react;
    if (!existsSync(path)) path = [".ts", ".tsx", ".json"].map(extension => path + extension).find(existsSync);
    assert.ok(path, "Hook dependency must resolve");
    if (replacements.has(path)) return replacements.get(path);
    if (modules.has(path)) return modules.get(path);
    if (path.endsWith(".json")) return JSON.parse(readFileSync(path, "utf8"));
    const exports = {};
    modules.set(path, exports);
    const source = readFileSync(path, "utf8").replaceAll("import.meta.env.MODE", '"production"');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, { ...globals, exports, require: name => load(name === "react" ? name : resolve(dirname(path), name)) }, { filename: path });
    return exports;
  }
  const hook = inventoryOnly ? load(resolve(web, "features/storefront/useInventory.ts")).useInventory
    : load(resolve(web, "app/useCampusStore.ts")).useCampusStore;
  const render = () => { cursor = 0; dirty = false; result = hook(navigator.onLine); while (effects.length) effects.shift()(); };
  const flush = async () => { for (let tick = 0; tick < 30; tick++) { await Promise.resolve(); if (dirty) render(); } };
  render();
  return {
    calls, publishes, localStorage, window, document, flush,
    get value() { return result; }, get controller() { return controller; }, get now() { return now; }, get timers() { return jobs.size; },
    tab(type) { for (const listener of tabListeners) listener(type); },
    visibility(visible) { document.visibilityState = visible ? "visible" : "hidden"; document.dispatchEvent(new Event("visibilitychange")); },
    connectivity(connected) { navigator.onLine = connected; window.dispatchEvent(new Event(connected ? "online" : "offline")); if (inventoryOnly) render(); },
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, job] = next; now = job.at;
        if (job.interval) job.at += job.interval; else jobs.delete(id);
        job.callback(); await flush();
      }
      now = end; await flush();
    },
    stop() { for (const entry of state) entry?.cleanup?.(); },
  };
}
const count = (host, prefix) => host.calls.filter(call => call.path.startsWith(prefix)).length;
const fresh = () => ({ catalog: catalog(), fetchedAt: 1000000 });

test("simultaneous tabs serialize inventory and reuse the newer shared snapshot", async t => {
  let tail = Promise.resolve();
  const locks = { request(name, run) { assert.equal(name, "campus-inventory-read"); const task = tail.then(run); tail = task.catch(() => {}); return task; } };
  const sharedValues = new Map(), response = deferred();
  const request = path => path === "/api/catalog" ? response.promise : undefined;
  const a = browser({ inventoryOnly: true, locks, sharedValues, request });
  const b = browser({ inventoryOnly: true, locks, sharedValues, request });
  t.after(a.stop); t.after(b.stop);
  await a.flush(); await b.flush();
  assert.equal(a.calls.length + b.calls.length, 1);
  response.resolve(catalog(9)); await a.flush(); await b.flush();
  assert.equal(a.calls.length + b.calls.length, 1);
  assert.equal(b.value.catalog.products[0].stock, 9);
  await b.value.refreshInventory(true); await b.flush();
  assert.equal(a.calls.length + b.calls.length, 2, "explicit mutation invalidations still fetch authoritative stock");
});

test("wake events and checkout recovery share one in-flight read and retry after settlement", async t => {
  let response = deferred();
  const host = browser({ reservation: hold(), snapshot: fresh(), request: path => path.startsWith("/api/checkouts/") ? response.promise : undefined });
  t.after(host.stop); await host.flush();
  host.window.dispatchEvent(new Event("focus")); host.visibility(true);
  host.window.dispatchEvent(new Event("pageshow")); host.tab("checkout");
  host.controller.reconcileCheckout(); host.controller.reconcileCheckout();
  assert.equal(count(host, "/api/checkouts/"), 1, "previously each wake issued a parallel checkout request");
  response.reject(new Error("temporary outage")); await host.flush();
  assert.ok(host.value.reservation, "uncertain checkout must survive a transport failure");
  response = deferred(); host.controller.reconcileCheckout();
  assert.equal(count(host, "/api/checkouts/"), 2, "settled failures do not block the next recovery read");
  response.resolve({ status: "held", expiresAt: 1300000, serverNow: host.now }); await host.flush();
});

test("checkout single-flight keys include account epoch and discard delayed old-account orders", async t => {
  const responses = [];
  const host = browser({ reservation: hold(), snapshot: fresh(), request: path => {
    if (path.startsWith("/api/checkouts/")) { const response = deferred(); responses.push(response); return response.promise; }
  } });
  t.after(host.stop); await host.flush();
  host.controller.sessionExpired(); await host.flush();
  host.window.dispatchEvent(new Event("focus")); await host.flush();
  assert.equal(responses.length, 2, "a replacement account must not join the old account's pending read");
  responses[0].resolve({ id: "old-account-order", status: "delivered" }); await host.flush();
  assert.equal(host.value.orders.length, 0); assert.ok(host.value.reservation);
  responses[1].resolve({ status: "held", expiresAt: 1300000, serverNow: host.now }); await host.flush();
});

test("checkout reads cannot apply during a mutation or replace a different stored checkout", async t => {
  const first = deferred(), second = deferred(), cancel = deferred();
  const newer = hold("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  const host = browser({ reservation: hold(), snapshot: fresh(), request: (path, options) => {
    if (options?.method === "POST") return cancel.promise;
    if (path.startsWith("/api/checkouts/")) return path.endsWith(newer.key) ? second.promise : first.promise;
  } });
  t.after(host.stop); await host.flush();
  host.localStorage.setItem("campus-checkout-hold", JSON.stringify(newer)); host.tab("checkout"); await host.flush();
  assert.equal(count(host, "/api/checkouts/"), 2);
  first.resolve({ id: "stale-order", status: "delivered" }); await host.flush();
  assert.equal(host.value.orders.length, 0); assert.equal(host.value.reservation.key, newer.key);
  const cancelling = host.value.cancelCheckout(); await host.flush();
  second.resolve({ status: "held", expiresAt: 1300000, serverNow: host.now }); await host.flush();
  assert.equal(host.value.reservation.phase, "cancelling", "a read cannot overwrite an active mutation");
  host.controller.reconcileCheckout(); assert.equal(count(host, "/api/checkouts/"), 2);
  cancel.resolve({ status: "cancelled" }); await cancelling; await host.flush();
  assert.equal(host.value.reservation, null);
});

test("hidden tab events synchronize the bag immediately but coalesce network work until wake", async t => {
  const host = browser({ snapshot: fresh() }); t.after(host.stop); await host.flush(); host.calls.length = 0;
  host.visibility(false); await host.flush();
  host.localStorage.setItem("campus-cart", JSON.stringify({ sandwich: 2 }));
  host.tab("orders"); host.tab("session"); host.tab("orders"); await host.flush();
  assert.equal(host.value.cart.sandwich, 2); assert.equal(host.calls.length, 0);
  await host.advance(1000); host.visibility(true);
  host.window.dispatchEvent(new Event("focus")); host.window.dispatchEvent(new Event("pageshow")); await host.flush();
  assert.equal(count(host, "/api/session"), 1);
  assert.equal(count(host, "/api/catalog"), 1, "fresh catalog cache must not swallow a deferred order invalidation");
  assert.equal(host.value.inventoryFetchedAt, host.now);
});

test("hidden catalog timers make zero requests and wake adopts another tab's newer snapshot", async t => {
  const host = browser({ inventoryOnly: true, hidden: true, snapshot: fresh() }); t.after(host.stop); await host.flush();
  await host.advance(3600000);
  assert.equal(host.calls.length, 0, "previously four catalog reads per hidden hour"); assert.equal(host.timers, 0);
  const fetchedAt = host.now - 1000;
  host.localStorage.setItem("campus-inventory-v1", JSON.stringify({ catalog: catalog(3), fetchedAt }));
  host.visibility(true); await host.flush();
  assert.equal(host.calls.length, 0); assert.equal(host.value.catalog.products[0].stock, 3);
  assert.equal(host.value.inventoryFetchedAt, fetchedAt, "hydration must not invent a fetch timestamp");
  assert.equal(host.timers, 1); host.visibility(false); await host.flush(); assert.equal(host.timers, 0);
});

test("forced hidden/offline refresh remains dirty until visible and online", async t => {
  const host = browser({ inventoryOnly: true, hidden: true, online: false, snapshot: fresh() }); t.after(host.stop); await host.flush();
  await host.value.refreshInventory(true); assert.equal(host.calls.length, 0);
  await host.advance(1000); host.connectivity(true); await host.flush(); assert.equal(host.calls.length, 0);
  host.visibility(true); await host.flush();
  assert.equal(count(host, "/api/catalog"), 1); assert.equal(host.value.inventoryFetchedAt, host.now);
});

test("a forced refresh during a catalog fetch queues one subsequent read without parallel traffic", async t => {
  const responses = [];
  const host = browser({ inventoryOnly: true, snapshot: fresh(), request: path => {
    if (path === "/api/catalog") { const response = deferred(); responses.push(response); return response.promise; }
  } });
  t.after(host.stop); await host.flush();
  const before = host.value.refreshInventory(true);
  const after = host.value.refreshInventory(true); host.value.refreshInventory(true);
  assert.equal(responses.length, 1);
  responses[0].resolve(catalog(9)); await host.flush(); assert.equal(responses.length, 2);
  responses[1].resolve(catalog(8)); await Promise.all([before, after]); await host.flush();
  assert.equal(host.value.catalog.products[0].stock, 8); assert.equal(responses.length, 2);
});

test("coded CSRF rejection refreshes the cookie's account without replaying the purchase", async t => {
  const staleCheckout = deferred(), replacement = deferred();
  let sessionReads = 0, purchases = 0;
  const nextAccount = { csrf: "account-b-token", accountId: "account-b", balanceCents: 5000, nextOrderAt: null, serverNow: 1000000, orders: [] };
  const host = browser({ reservation: hold(), snapshot: fresh(), request: (path, options) => {
    if (path.startsWith("/api/session") && ++sessionReads > 1) return replacement.promise;
    if (path.startsWith("/api/checkouts/")) return staleCheckout.promise;
    if (options?.method === "POST") {
      if (++purchases === 1) return Promise.reject(Object.assign(new Error("Session validation failed. Reload and try again."), { status: 403, code: "csrf_mismatch" }));
      return { status: "held", expiresAt: 1300000, serverNow: 1000000 };
    }
  } });
  t.after(host.stop); await host.flush();
  await host.value.placeOrder(); await host.flush();
  assert.equal(sessionReads, 2, "previously coded rejection did not request a new session snapshot");
  assert.equal(host.value.session, null, "stale identity is cleared before replacement completes");
  assert.equal(purchases, 1); assert.equal(host.value.reservation.key, hold().key);
  assert.match(host.value.error, /Session validation failed/);
  staleCheckout.resolve({ id: "old-account-order", status: "delivered" }); await host.flush();
  assert.equal(host.value.orders.length, 0); assert.equal(host.value.reservation.phase, "confirming");
  replacement.resolve(nextAccount); await host.flush();
  assert.equal(host.value.session.csrf, nextAccount.csrf); assert.equal(purchases, 1);
  assert.match(host.value.error, /Session validation failed/, "identity refresh does not hide the failed action");
  await host.value.placeOrder(); await host.flush();
  const retry = host.calls.filter(call => call.options?.method === "POST")[1];
  assert.equal(retry.options.headers["X-CSRF-Token"], nextAccount.csrf);
  assert.equal(retry.options.headers["Idempotency-Key"], hold().key, "manual retry retains the durable checkout ID");
});

test("other forbidden responses do not reset or refresh the account", async t => {
  const host = browser({ reservation: hold(), snapshot: fresh(), request: (_path, options) => {
    if (options?.method === "POST") return Promise.reject(Object.assign(new Error("Request origin is not allowed."), { status: 403 }));
  } });
  t.after(host.stop); await host.flush();
  const priorReads = count(host, "/api/session");
  await host.value.placeOrder(); await host.flush();
  assert.equal(count(host, "/api/session"), priorReads);
  assert.equal(host.value.session.csrf, "account-a");
  assert.match(host.value.error, /Request origin is not allowed/);
});
