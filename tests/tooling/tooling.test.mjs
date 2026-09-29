import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { transform, transformSync } from "@esbuild-kit/core-utils";

test("the patched TypeScript loader handles both sync and async transforms", async () => {
  const module = { exports: {} };
  const fixture = "export const result: number = 6 * 7;";
  const sync = transformSync(fixture, "fixture.ts");
  runInNewContext(sync.code, { module, exports: module.exports });
  assert.equal(module.exports.result, 42);
  // Exercise the actual Drizzle schema and preserve useful source maps.
  const asyncResult = await transform(readFileSync("packages/database/schema.ts", "utf8"), "schema.ts");
  assert.match(asyncResult.code, /sqliteTable/);
  assert.ok(asyncResult.map);
});

test("the native project parser can edit and serialize with the patched UUID dependency", () => {
  const require = createRequire(import.meta.url);
  const xcode = require("xcode");
  const parser = require("xcode/lib/parser/pbxproj.js");
  const project = xcode.project("apps/mobile/ios/App/App.xcodeproj/project.pbxproj");
  project.parseSync();
  const firstTarget = project.getFirstTarget();
  assert.ok(firstTarget.uuid);
  assert.match(project.generateUuid(), /^[A-F0-9]{24}$/);
  // This exercises the code path Capacitor uses; the real Xcode file stays untouched.
  const appGroup = project.findPBXGroupKey({ path: "App" });
  assert.ok(appGroup);
  project.addSourceFile("App/RefactorSmoke.swift", { target: firstTarget.uuid }, appGroup);
  const serialized = project.writeSync();
  assert.match(serialized, /RefactorSmoke\.swift/);
  assert.ok(parser.parse(serialized).project);
});
