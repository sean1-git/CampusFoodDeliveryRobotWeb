import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve("dist/client");
test("manifest icons have their declared PNG sizes and built files exist", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "manifest.webmanifest"), "utf8"),
  );
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) {
    const bytes = readFileSync(resolve(root, "." + icon.src));
    assert.equal(
      `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`,
      icon.sizes,
    );
  }
  assert.ok(existsSync(resolve(root, "sw.js")));
});
function serviceWorker(fetchImpl, { denyStorage = false, quota = false, optional } = {}) {
  const handlers = {};
  const stored = new Map();
  const media = new Map();
  const removed = [];
  let skipped = false;
  const cacheFor = entries => ({
    add: async file => { if(quota) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); entries.set(file, new Response(file)); },
    match: async (path) => entries.get(path)?.clone(),
    keys: async () => [...entries.keys()].map(path => ({ url: 'https://campus.test'+path })),
    delete: async key => entries.delete(typeof key === 'string' ? key : new URL(key.url).pathname),
    put: async (path, response) => { if(quota) throw new Error('quota'); entries.set(path, response); },
  });
  const caches = {
    open: async name => { if(denyStorage) throw new Error('denied'); return cacheFor(name.endsWith('-media') ? media : stored); },
    keys: async () => ["campus-shell-old", "unrelated-cache"],
    delete: async (key) => removed.push(key),
  };
  const self = {
    location: { origin: "https://campus.test" },
    addEventListener: (name, fn) => (handlers[name] = fn),
    skipWaiting: () => {
      skipped = true;
    },
  };
  let source = readFileSync(resolve(root, "sw.js"), "utf8");
  if(optional) source = source.replace(/const OPTIONAL=.*;/, `const OPTIONAL=${JSON.stringify(optional)};`);
  runInNewContext(source, {
    self,
    caches,
    fetch: fetchImpl,
    URL,
    Response,
  });
  return { handlers, stored, media, removed, skipped: () => skipped };
}
test("offline navigation falls back to the cached app and APIs bypass the cache", async () => {
  const sw = serviceWorker(async () => {
    throw new Error("offline");
  });
  let installation;
  sw.handlers.install({ waitUntil: (promise) => (installation = promise) });
  await installation;
  assert.ok(sw.stored.has("/index.html"));
  assert.ok(sw.stored.has("/uc-merced-campus.jpg"));
  assert.ok([...sw.stored.keys()].every((path) => !path.startsWith("/api/")));
  let response;
  sw.handlers.fetch({
    request: { method: "GET", url: "https://campus.test/", mode: "navigate" },
    respondWith: (promise) => (response = promise),
  });
  assert.equal(await (await response).text(), "/index.html");
  let intercepted = false;
  for (const request of [
    { method: "GET", url: "https://campus.test/api/session" },
    { method: "POST", url: "https://campus.test/api/orders" },
    { method: "GET", url: "https://another.test/file.js" },
  ])
    sw.handlers.fetch({
      request,
      respondWith: () => {
        intercepted = true;
      },
    });
  assert.equal(intercepted, false);
});
test("updates activate only on request and clean only this app cache", async () => {
  const sw = serviceWorker(async () => new Response("online"));
  assert.equal(sw.skipped(), false);
  sw.handlers.message({ data: { type: "SKIP_WAITING" } });
  assert.equal(sw.skipped(), true);
  let activation;
  sw.handlers.activate({ waitUntil: (promise) => (activation = promise) });
  await activation;
  assert.deepEqual(sw.removed, ["campus-shell-old"]);
});

test("cached navigation does not wait for a stalled connection", async () => {
  let network = 0;
  const sw = serviceWorker(() => { network++; return new Promise(() => {}); });
  let installed, response;
  sw.handlers.install({ waitUntil: p => installed = p }); await installed;
  sw.handlers.fetch({ request: { method: "GET", url: "https://campus.test/", mode: "navigate" }, respondWith: p => response = p });
  assert.equal(await (await response).text(), "/index.html"); assert.equal(network, 0);
  assert.ok(!sw.stored.has("/icon-512.png"), "large installation icon is not eagerly cached");
  assert.ok(!sw.stored.has("/bobcat-snack-shop.jpg"), "shop photos load on demand");
});

test("storage denial and quota pressure preserve online navigation", async () => {
  for(const options of [{ denyStorage: true }, { quota: true }]) {
    const sw = serviceWorker(async () => new Response("online shell"), options);
    let installed, response;
    sw.handlers.install({ waitUntil: p => installed = p }); await installed;
    sw.handlers.fetch({ request: { method: "GET", url: "https://campus.test/", mode: "navigate" }, respondWith: p => response = p });
    assert.equal(await (await response).text(), "online shell");
  }
});

test("optional photos are cached only after use and unknown URLs bypass the cache", async () => {
  let network = 0;
  const sw = serviceWorker(async () => { network++; return new Response("photo"); });
  let response, saved;
  const request = { method: "GET", url: "https://campus.test/bobcat-snack-shop.jpg" };
  sw.handlers.fetch({ request, respondWith: p => response = p, waitUntil: p => saved = p });
  assert.equal(await (await response).text(), "photo"); await saved;
  sw.handlers.fetch({ request, respondWith: p => response = p, waitUntil: p => saved = p });
  assert.equal(await (await response).text(), "photo"); await saved; assert.equal(network, 1);
  let intercepted = false;
  sw.handlers.fetch({ request: { method: "GET", url: "https://campus.test/unbounded-upload.jpg" }, respondWith: () => intercepted = true });
  assert.equal(intercepted, false);
});

test("optional cache enforces entry and byte limits without evicting the shell", async () => {
  for(const size of [20, 500000]) {
    const optional = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`/photo-${i}.jpg`, size]));
    const sw = serviceWorker(async () => new Response('x'.repeat(size)), { optional });
    let installed;
    sw.handlers.install({ waitUntil: p => installed = p }); await installed;
    for(const path of Object.keys(optional)) {
      let saved;
      sw.handlers.fetch({ request: { method: 'GET', url: 'https://campus.test'+path }, respondWith: () => {}, waitUntil: p => saved = p });
      await saved;
    }
    assert.ok(sw.media.size <= 12);
    assert.ok(sw.media.size * size <= 2 * 1024 * 1024);
    assert.ok(!sw.media.has('/photo-0.jpg'));
    assert.ok(sw.stored.has('/index.html'));
  }
});


test("first service-worker takeover avoids reload; later updates reload only once", () => {
  const source = readFileSync("apps/web/src/shared/pwa/pwa.ts", "utf8").replace("import.meta.env.PROD", "true").replace("import.meta.env.MODE", '"production"');
  for (const initiallyControlled of [false, true]) {
    let reloads = 0;
    const handlers = {};
    runInNewContext(source, {
      navigator: { serviceWorker: { controller: initiallyControlled ? {} : null,
        addEventListener: (name, fn) => { handlers[name] = fn; } } },
      window: { addEventListener() {}, location: { reload() { reloads++; } } },
    });
    handlers.controllerchange();
    assert.equal(reloads, initiallyControlled ? 1 : 0);
    handlers.controllerchange();
    handlers.controllerchange();
    assert.equal(reloads, 1);
  }
});


test("native builds never register the website service worker", () => {
  const source = readFileSync("apps/web/src/shared/pwa/pwa.ts", "utf8").replace("import.meta.env.PROD", "true").replace("import.meta.env.MODE", '"native"');
  let listeners = 0;
  runInNewContext(source, {
    navigator: { serviceWorker: { addEventListener() { listeners++; } } },
    window: { addEventListener() { listeners++; } },
  });
  assert.equal(listeners, 0);
});
