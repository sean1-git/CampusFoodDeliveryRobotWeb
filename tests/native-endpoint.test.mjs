import test from "node:test";
import assert from "node:assert/strict";
import { nativeEndpoint } from "../src/lib/nativeEndpoint.ts";

test("native API URLs retain paths and queries on the configured HTTPS origin", () => {
  assert.equal(nativeEndpoint("/api/session?include=orders", "https://campus.test").href,
    "https://campus.test/api/session?include=orders");
});
test("native requests reject insecure origins and paths that escape the API", () => {
  for (const origin of ["http://campus.test", "https://user:secret@campus.test", "https://campus.test/api", "https://campus.test?key=x"])
    assert.throws(() => nativeEndpoint("/api/session", origin));
  for (const path of ["https://other.test/api/session", "//other.test/api/session", "/api/../../session", "/api/\\other", "/api/session#secret"])
    assert.throws(() => nativeEndpoint(path, "https://campus.test"));
});
