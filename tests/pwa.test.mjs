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
function serviceWorker(fetchImpl) {
  const handlers = {};
  const stored = new Map();
  const removed = [];
  let skipped = false;
  const cache = {
    addAll: async (files) =>
      files.forEach((file) => stored.set(file, new Response(file))),
    match: async (path) => stored.get(path),
  };
  const caches = {
    open: async () => cache,
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
  runInNewContext(readFileSync(resolve(root, "sw.js"), "utf8"), {
    self,
    caches,
    fetch: fetchImpl,
    URL,
    Response,
  });
  return { handlers, stored, removed, skipped: () => skipped };
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
