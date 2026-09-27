import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { acceptedEncodings, staticBody } from "../server/static-assets.mjs";

test("static compression honors requested encodings and exclusions", () => {
  assert.deepEqual(acceptedEncodings(), []);
  assert.deepEqual(acceptedEncodings("gzip, br"), ["br", "gzip"]);
  assert.deepEqual(acceptedEncodings("br;q=0, gzip;q=0.8"), ["gzip"]);
  assert.deepEqual(acceptedEncodings("gzip;q=1, br;q=0.5"), ["gzip", "br"]);
  assert.deepEqual(acceptedEncodings("*;q=1,br;q=0"), ["gzip"]);
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
