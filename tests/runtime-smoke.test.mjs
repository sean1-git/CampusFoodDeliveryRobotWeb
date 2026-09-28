import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repository = fileURLToPath(new URL("../", import.meta.url));

async function availablePort() {
  const socket = createServer();
  await new Promise((done, fail) => { socket.once("error", fail); socket.listen(0, "127.0.0.1", done); });
  const port = socket.address().port;
  await new Promise((done, fail) => socket.close(error => error ? fail(error) : done()));
  return port;
}

test("production runtime works outside the checkout without node_modules", { timeout: 45000 }, async t => {
  // Match the Docker runtime payload; the temporary parent cannot resolve this
  // checkout's dependencies or reuse its development database/environment.
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "campus-runtime-"));
  let child, closed;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await closed; } finally { clearTimeout(force); }
    }
    const target = await realpath(directory);
    assert.equal(dirname(target), temporaryRoot, "Cleanup must stay inside the temporary directory");
    assert.ok(basename(target).startsWith("campus-runtime-"));
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  await mkdir(join(directory, "dist"));
  await mkdir(join(directory, "drizzle"));
  await Promise.all([
    ...["server", "shared", "package.json", "dist/client"].map(path => cp(join(repository, path), join(directory, path), { recursive: true })),
    ...(await readdir(join(repository, "drizzle"))).filter(name => name.endsWith(".sql"))
      .map(name => cp(join(repository, "drizzle", name), join(directory, "drizzle", name))),
  ]);
  await assert.rejects(access(join(directory, "node_modules")));
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  const environment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  child = spawn(process.execPath, ["server/local.mjs"], {
    cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...environment, NODE_ENV: "production", INTEGRATION_MODE: "demo", HOST: "127.0.0.1",
      PORT: String(port), CANONICAL_ORIGIN: "https://campus.test" },
  });
  closed = new Promise(done => child.once("close", done));
  await new Promise((done, fail) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error(`Runtime startup timed out: ${output}`)), 15000);
    const finish = error => {
      clearTimeout(timeout); child.off("error", onError); child.off("close", onClose);
      if (error) fail(error); else done();
    };
    const onError = error => finish(error);
    const onClose = code => finish(new Error(`Runtime exited before listening (${code}): ${output}`));
    child.once("error", onError); child.once("close", onClose);
    child.stderr.on("data", data => { output = (output + data).slice(-8000); });
    child.stdout.on("data", data => {
      output = (output + data).slice(-8000);
      if (output.includes(`Campus Store demo: ${origin}`)) finish();
    });
  });

  const root = await fetch(origin, { signal: AbortSignal.timeout(5000) });
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type"), /text\/html/);
  const html = await root.text();
  assert.match(html, /<!doctype html>/i);
  const script = html.match(/src="(\/assets\/[^"]+\.js)"/);
  assert.ok(script, "Production HTML must reference the bundled application");
  const asset = await fetch(origin + script[1], { signal: AbortSignal.timeout(5000) });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.ok((await asset.text()).length > 0);
  const robots = await fetch(origin + "/robots.txt", { signal: AbortSignal.timeout(5000) });
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type"), /text\/plain/);
  assert.match(await robots.text(), /^User-agent:/m);

  const photo = await fetch(origin + "/summit-marketplace.jpg", { signal: AbortSignal.timeout(5000) });
  assert.equal(photo.status, 200);
  assert.match(photo.headers.get("content-type"), /image\/jpeg/);
  assert.ok(photo.headers.get("etag"));
  await photo.arrayBuffer();
  const unchanged = await fetch(origin + "/summit-marketplace.jpg", {
    headers: { "If-None-Match": photo.headers.get("etag") }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(unchanged.status, 304);
  assert.equal((await unchanged.arrayBuffer()).byteLength, 0);

  let cookie = "", csrf = "";
  const key = randomUUID();
  async function api(path, body) {
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST",
      headers: { Origin: "https://campus.test", "Content-Type": "application/json", "Idempotency-Key": key,
        ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { response, body: await response.json() };
  }
  const catalog = await api("/api/catalog");
  assert.equal(catalog.response.status, 200);
  const sandwich = catalog.body.products.find(product => product.id === "sandwich");
  assert.equal(sandwich.priceCents + catalog.body.deliveryFeeCents, 750);
  assert.equal(sandwich.stock, 20);
  const session = await api("/api/session?include=orders");
  assert.equal(session.response.status, 200);
  assert.equal(session.body.balanceCents, 5000);
  assert.deepEqual(session.body.orders, []);
  const issuedCookie = session.response.headers.get("set-cookie");
  assert.match(issuedCookie, /HttpOnly/i);
  assert.match(issuedCookie, /Secure/i);
  cookie = issuedCookie.split(";")[0]; csrf = session.body.csrf;
  assert.ok(csrf);
  // Exercise the actual Node socket bridge: buffering Response.arrayBuffer()
  // would hang here even if the API's in-memory stream unit tests passed.
  const streamAbort = new AbortController();
  const events = await fetch(origin + "/api/events", {
    headers: { Cookie: cookie, Origin: "https://campus.test" },
    signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(10000)]),
  });
  assert.equal(events.status, 200);
  assert.match(events.headers.get("content-type"), /text\/event-stream/);
  assert.match(events.headers.get("cache-control"), /no-store/);
  const reader = events.body.getReader();
  t.after(() => { streamAbort.abort(); });
  let received = "";
  async function untilEvent(name) {
    while (!received.includes(`event: ${name}\n`)) {
      const next = await reader.read();
      assert.equal(next.done, false, "Event stream closed before its notification");
      received += new TextDecoder().decode(next.value);
    }
  }
  await untilEvent("ready");
  let held = await api("/api/reservations", { items: [{ id: "sandwich", quantity: 1 }],
    destination: { lat: 37.365562, lng: -120.424938, confirmed: true } });
  for (let tries = 0; held.response.status === 202 && tries < 20; tries++) {
    await delay(100); held = await api(`/api/checkouts/${key}`);
  }
  assert.equal(held.response.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.status, "held");
  await untilEvent("change");
  await reader.cancel();
  streamAbort.abort();
  assert.equal((await api("/api/session")).body.balanceCents, 5000);
  const order = await api(`/api/reservations/${key}/confirm`, {});
  assert.equal(order.response.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.totalCents, 750);
  assert.deepEqual(order.body.deliveryRoute.pickups.map(pickup => pickup.id), ["library"]);
  const retry = await api(`/api/reservations/${key}/confirm`, {});
  assert.equal(retry.response.status, 201);
  assert.equal(retry.body.id, order.body.id);
  const after = await api("/api/session?include=orders");
  assert.equal(after.body.balanceCents, 4250);
  assert.equal(after.body.orders.length, 1);
  assert.equal(after.body.nextOrderAt, order.body.arrivesAt);
  assert.equal((await api("/api/catalog")).body.products.find(product => product.id === "sandwich").stock, 19);
  await access(resolve(directory, ".data/campus-demo.sqlite"));
});
