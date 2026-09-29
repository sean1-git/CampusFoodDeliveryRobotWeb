import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { JSON_BODY_TIMEOUT_MS, readSmallJson } from "../../apps/api/src/http/http.mjs";
import { handleApi } from "../../apps/api/src/api.mjs";
import { openDatabase } from "../../apps/api/src/database/local-db.mjs";
import { studentSession } from "../fixtures/student-fixture.mjs";

const encoder = new TextEncoder();
const flush = () => new Promise(resolve => setImmediate(resolve));

function scheduler(t) {
  const timers = new Map();
  let next = 0, now = 0;
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    const id = ++next;
    timers.set(id, { callback, at: now + milliseconds });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", id => timers.delete(id));
  return {
    count: () => timers.size,
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
      await flush();
    },
  };
}

function bodyRequest({ chunks = [], complete = false, cancel = () => {}, signal, headers = {} } = {}) {
  let controller;
  const body = new ReadableStream({
    start(sink) {
      controller = sink;
      for (const chunk of chunks) sink.enqueue(chunk);
      if (complete) sink.close();
    },
    cancel,
  });
  const request = new Request("https://campus.test/api/reservations", {
    method: "POST", duplex: "half", body, signal,
    headers: { "content-type": "application/json", ...headers },
  });
  return { request, controller };
}

function assertClean(request, clock) {
  assert.equal(request.body.locked, false, "Body reader must be released");
  assert.equal(getEventListeners(request.signal, "abort").length, 0);
  assert.equal(clock.count(), 0, "Body timeout must be removed");
}

test("chunked JSON accepts exactly 8192 bytes, including split UTF-8, and releases resources", async t => {
  const clock = scheduler(t), expected = { value: "é".repeat(4090) };
  const bytes = encoder.encode(JSON.stringify(expected));
  assert.equal(bytes.length, 8192);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 257) chunks.push(bytes.subarray(offset, offset + 257));
  const { request } = bodyRequest({ chunks, complete: true });
  assert.deepEqual(await readSmallJson(request), expected);
  assertClean(request, clock);
});

test("streamed byte limit cannot be bypassed by Content-Length and cancellation failure stays handled", async t => {
  const clock = scheduler(t);
  let cancellations = 0;
  const { request } = bodyRequest({ chunks: [new Uint8Array(4096), new Uint8Array(4097)],
    headers: { "content-length": "2" }, cancel() { cancellations++; return Promise.reject(new Error("producer failed")); } });
  await assert.rejects(readSmallJson(request), /TOO_LARGE/);
  await flush();
  assert.equal(cancellations, 1);
  assertClean(request, clock);
});

test("invalid JSON and failed body streams remove their timer and abort listener", async t => {
  const clock = scheduler(t);
  const invalid = bodyRequest({ chunks: [encoder.encode("{")], complete: true }).request;
  await assert.rejects(readSmallJson(invalid), /INVALID_JSON/);
  assertClean(invalid, clock);
  const { request, controller } = bodyRequest();
  const failed = assert.rejects(readSmallJson(request), /transport failed/);
  controller.error(new Error("transport failed"));
  await failed;
  assertClean(request, clock);
});

test("already-aborted and mid-upload aborted requests cancel promptly and clean up", async t => {
  const clock = scheduler(t);
  for (const alreadyAborted of [true, false]) {
    let cancellations = 0;
    const abort = new AbortController();
    if (alreadyAborted) abort.abort();
    const { request } = bodyRequest({ signal: abort.signal, cancel() { cancellations++; } });
    const rejected = assert.rejects(readSmallJson(request), /REQUEST_ABORTED/);
    if (!alreadyAborted) abort.abort();
    await rejected;
    assert.equal(cancellations, 1);
    assertClean(request, clock);
  }
  // Buffered bytes must not win a race against an already-aborted request.
  const abort = new AbortController();
  abort.abort();
  const buffered = bodyRequest({ chunks: [encoder.encode("{}")], complete: true, signal: abort.signal }).request;
  await assert.rejects(readSmallJson(buffered), /REQUEST_ABORTED/);
  assertClean(buffered, clock);
});

test("one upload deadline bounds a stalled or trickling body even if cancellation never settles", async t => {
  const clock = scheduler(t);
  let cancellations = 0;
  const { request, controller } = bodyRequest({ cancel() { cancellations++; return new Promise(() => {}); } });
  const timedOut = assert.rejects(readSmallJson(request), /REQUEST_TIMEOUT/);
  await clock.advance(JSON_BODY_TIMEOUT_MS - 1);
  controller.enqueue(encoder.encode("{"));
  await flush();
  assert.equal(cancellations, 0);
  await clock.advance(1);
  await timedOut;
  assert.equal(cancellations, 1);
  assertClean(request, clock);
});

test("missing bodies and wrong media types fail without allocating a timeout", async t => {
  const clock = scheduler(t);
  const missing = new Request("https://campus.test/api/orders", { method: "POST", headers: { "content-type": "application/json" } });
  await assert.rejects(readSmallJson(missing), /INVALID_JSON/);
  const wrong = new Request("https://campus.test/api/orders", { method: "POST", body: "{}" });
  await assert.rejects(readSmallJson(wrong), /JSON_REQUIRED/);
  assert.equal(clock.count(), 0);
});

test("timed-out checkout uploads return 408 without queuing an order or charging stock", async t => {
  const clock = scheduler(t), DB = openDatabase();
  t.after(() => DB.close());
  const user = await studentSession(DB);
  const { request } = bodyRequest({ headers: {
    origin: "https://campus.test", cookie: user.cookie, "x-csrf-token": user.csrf,
    "idempotency-key": crypto.randomUUID(),
  } });
  const pending = handleApi(request, { DB });
  await flush();
  assert.equal(clock.count(), 1);
  await clock.advance(JSON_BODY_TIMEOUT_MS);
  const response = await pending;
  assert.equal(response.status, 408);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).code, "request_timeout");
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM checkout_queue").first()).count, 0);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM orders").first()).count, 0);
  assertClean(request, clock);
});
