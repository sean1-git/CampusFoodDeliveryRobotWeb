import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { acceptedEncodings, staticBody, staticResponse } from "../../apps/api/src/http/static-assets.mjs";

function temporaryDirectory(t) {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, "campus-static-security-"));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), root);
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("static compression honors requested encodings and exclusions", () => {
  assert.deepEqual(acceptedEncodings(), []);
  assert.deepEqual(acceptedEncodings("gzip, br"), ["br", "gzip"]);
  assert.deepEqual(acceptedEncodings("br;q=0, gzip;q=0.8"), ["gzip"]);
  assert.deepEqual(acceptedEncodings("gzip;q=1, br;q=0.5"), ["gzip", "br"]);
  assert.deepEqual(acceptedEncodings("*;q=1,br;q=0"), ["gzip"]);
});

test("static validators save repeat transfers without mixing compressed representations", async () => {
  const headers = () => ({ "Content-Type": "text/html", "Cache-Control": "no-cache" });
  const first = staticResponse("dist/client/index.html", "br", headers());
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const cached = staticResponse("dist/client/index.html", "br", headers(), { ifNoneMatch: `"other", W/${etag}` });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  assert.equal(cached.headers.get("vary"), "Accept-Encoding");
  assert.equal(cached.headers.get("cache-control"), "no-cache");
  const identity = staticResponse("dist/client/index.html", "identity", headers(), { ifNoneMatch: etag });
  assert.equal(identity.status, 200);
  assert.notEqual(identity.headers.get("etag"), etag);
  assert.match(await identity.text(), /<!doctype html>/i);
});

test("HEAD returns the same static metadata with no response body", async () => {
  const file = "dist/client/bobcat-snack-shop.jpg";
  const get = staticResponse(file, "identity", { "Content-Type": "image/jpeg" });
  const head = staticResponse(file, "identity", { "Content-Type": "image/jpeg" }, { method: "HEAD" });
  assert.equal(head.headers.get("etag"), get.headers.get("etag"));
  assert.equal(Number(head.headers.get("content-length")), readFileSync(file).length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(staticResponse(file, "identity", {}, { method: "HEAD", ifNoneMatch: "*" }).status, 304);
});

test("changed static files invalidate cached bytes and validators", async t => {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "campus-static-"));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    rmSync(directory, { recursive: true, force: true });
  });
  const file = join(directory, "asset.txt");
  writeFileSync(file, "before");
  const first = staticResponse(file, "identity", {});
  writeFileSync(file, "changed content");
  const updated = staticResponse(file, "identity", {}, { ifNoneMatch: first.headers.get("etag") });
  assert.equal(updated.status, 200);
  assert.equal(await updated.text(), "changed content");
  assert.notEqual(updated.headers.get("etag"), first.headers.get("etag"));
});
test("compressed HTML retains identical content and cache negotiation headers", () => {
  const file="dist/client/index.html", original=readFileSync(file);
  for (const [encoding,decode] of [["br",brotliDecompressSync],["gzip",gunzipSync]]) {
    const headers={"Content-Type":"text/html"};
    const body=staticBody(file,encoding,headers);
    assert.equal(headers["Content-Encoding"],encoding);
    assert.equal(headers.Vary,"Accept-Encoding");
    assert.deepEqual(decode(body),original);
  }
  const headers={};
  assert.deepEqual(staticBody(file,"identity",headers),original);
  assert.equal(headers["Content-Encoding"],undefined);
});

test("replacing an asset path after inspection cannot substitute the opened file's bytes", async t => {
  const directory = temporaryDirectory(t), file = join(directory, "asset.txt"), displaced = join(directory, "old.txt");
  writeFileSync(file, "original public asset");
  let replaced = false;
  const intercept = inspect => (...args) => {
    const metadata = inspect(...args);
    if (!replaced) {
      replaced = true;
      assert.equal(dirname(resolve(file)), directory);
      assert.equal(dirname(resolve(displaced)), directory);
      renameSync(file, displaced);
      writeFileSync(file, "replacement asset");
    }
    return metadata;
  };
  // Exercise the actual race window, including the old path-stat implementation.
  t.mock.method(fs, "statSync", intercept(fs.statSync));
  t.mock.method(fs, "fstatSync", intercept(fs.fstatSync));
  syncBuiltinESMExports();
  try {
    const first = staticResponse(file, "identity", {});
    assert.equal(replaced, true);
    assert.equal(await first.text(), "original public asset");
    const next = staticResponse(file, "identity", {}, { ifNoneMatch: first.headers.get("etag") });
    assert.equal(next.status, 200);
    assert.equal(await next.text(), "replacement asset");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("opened descriptors close after reads, cache hits, and read failures", t => {
  const directory = temporaryDirectory(t), file = join(directory, "asset.txt"), failedFile = join(directory, "failed.txt");
  writeFileSync(file, "cacheable asset");
  writeFileSync(failedFile, "uncached asset");
  const opened = [], open = fs.openSync, inspect = fs.fstatSync, read = fs.readFileSync;
  t.mock.method(fs, "openSync", (...args) => { const descriptor = open(...args); opened.push(descriptor); return descriptor; });
  syncBuiltinESMExports();
  try {
    staticBody(file, "identity", {});
    staticBody(file, "identity", {});
    assert.equal(opened.length, 2);
    for (const descriptor of opened) assert.throws(() => inspect(descriptor), { code: "EBADF" });
    t.mock.method(fs, "readFileSync", (input, ...args) => {
      if (typeof input === "number") throw Object.assign(new Error("simulated read failure"), { code: "EIO" });
      return read(input, ...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => staticBody(failedFile, "identity", {}), { code: "EIO" });
    assert.throws(() => inspect(opened.at(-1)), { code: "EBADF" });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("missing compressed siblings fall back without stale headers, but read failures propagate", t => {
  const directory = temporaryDirectory(t), file = join(directory, "asset.txt");
  writeFileSync(file, "identity fallback");
  const headers = {};
  assert.equal(staticBody(file, "br,gzip", headers).toString(), "identity fallback");
  assert.equal(headers["Content-Encoding"], undefined);
  assert.equal(headers.Vary, "Accept-Encoding");
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (input, ...args) => {
    if (input === file + ".br") throw Object.assign(new Error("simulated access failure"), { code: "EACCES" });
    return open(input, ...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => staticBody(file, "br,gzip", {}), { code: "EACCES" }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
