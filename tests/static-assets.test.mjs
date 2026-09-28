import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { acceptedEncodings, staticBody, staticResponse } from "../server/static-assets.mjs";

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
