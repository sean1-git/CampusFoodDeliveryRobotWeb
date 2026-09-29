import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nativeEndpoint } from "../../apps/web/src/shared/api/nativeEndpoint.ts";

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

test("Android excludes account and checkout storage from cloud backup and device transfer", () => {
  const manifest = readFileSync(new URL("../../apps/mobile/android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:fullBackupContent="false"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  const rules = readFileSync(new URL("../../apps/mobile/android/app/src/main/res/xml/data_extraction_rules.xml", import.meta.url), "utf8");
  const domains = ["root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref"];
  for (const mode of ["cloud-backup", "device-transfer"]) {
    const section = rules.match(new RegExp(`<${mode}>([\\s\\S]*?)</${mode}>`))?.[1];
    assert.ok(section, `Missing ${mode} policy`);
    for (const domain of domains) assert.match(section, new RegExp(`<exclude\\s+domain="${domain}"\\s+path="\\."\\s*/>`));
  }
});

test("Android file sharing stays private and limited to a dedicated cache directory", () => {
  const manifest = readFileSync(new URL("../../apps/mobile/android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  const provider = manifest.match(/<provider\b[\s\S]*?<\/provider>/)?.[0];
  assert.ok(provider);
  assert.match(provider, /android:exported="false"/);
  const paths = readFileSync(new URL("../../apps/mobile/android/app/src/main/res/xml/file_paths.xml", import.meta.url), "utf8");
  assert.doesNotMatch(paths, /<(?:root|external|files)-path\b/);
  const directories = [...paths.matchAll(/<cache-path\b[^>]*\bpath="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(directories, ["shared/"]);
});
