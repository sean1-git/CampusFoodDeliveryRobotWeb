import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { generateMigration, validateMigrationHistory } from "../../tooling/database/generate-migration.mjs";

function digest(directory) {
  const hash = createHash("sha256");
  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      // Migration folders contain only SQL and the metadata subdirectory.
      if (name === "meta") visit(child);
      else hash.update(name).update(readFileSync(child));
    }
  }
  visit(directory); return hash.digest("hex");
}

function fixture(t, config = { dialect: "sqlite", out: "./migrations" }) {
  const temporaryRoot = realpathSync(tmpdir()), root = mkdtempSync(join(temporaryRoot, "campus-migration-guard-"));
  t.after(() => {
    const target = realpathSync(root); assert.equal(dirname(target), temporaryRoot);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const directory = join(root, "migrations"); mkdirSync(join(directory, "meta"), { recursive: true });
  writeFileSync(join(root, "drizzle.config.ts"), `export default ${JSON.stringify(config)};`);
  writeFileSync(join(directory, "0000_initial.sql"), "CREATE TABLE example (id TEXT PRIMARY KEY);");
  writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries: [
    { idx: 0, version: "6", tag: "0000_initial" },
  ] }));
  writeFileSync(join(directory, "meta/0000_snapshot.json"), JSON.stringify({ version: "6", dialect: "sqlite",
    id: "initial-snapshot", prevId: "00000000-0000-0000-0000-000000000000", tables: { example: {} } }));
  return { root, directory };
}

test("the repository's handwritten migrations stop generation without writing or invoking Drizzle", async () => {
  const directory = resolve("packages/database/migrations"), before = digest(directory);
  let invoked = false;
  await assert.rejects(generateMigration({ run() { invoked = true; throw new Error("Unexpected generator execution"); } }),
    /Unrecorded SQL:[\s\S]*0003_session_profile[\s\S]*docs\/DATABASE\.md/);
  assert.equal(invoked, false);
  assert.equal(digest(directory), before);
});

test("synchronized history permits the installed CLI and forwards arguments without a shell", async t => {
  const { root, directory } = fixture(t), before = digest(directory);
  const args = ["--name", "add_notes;literal", "--custom"];
  let invocation;
  assert.deepEqual(validateMigrationHistory(directory), { migrations: 1 });
  const status = await generateMigration({ root, args, run(...value) { invocation = value; return { status: 7 }; } });
  assert.equal(status, 7);
  assert.equal(invocation[0], process.execPath);
  assert.match(invocation[1][0], /drizzle-kit[/\\]bin\.cjs$/);
  assert.deepEqual(invocation[1].slice(1), ["generate", ...args]);
  assert.equal(invocation[2].shell, false);
  assert.equal(invocation[2].cwd, root);
  assert.equal(digest(directory), before);
});

test("missing SQL, invalid snapshots and broken history all block generation", async t => {
  for (const defect of ["sql", "snapshot", "extra", "dialect", "chain"]) {
    const { root, directory } = fixture(t), snapshot = join(directory, "meta/0000_snapshot.json");
    if (defect === "sql") rmSync(join(directory, "0000_initial.sql"));
    if (defect === "snapshot") rmSync(snapshot);
    if (defect === "extra") writeFileSync(join(directory, "meta/0001_snapshot.json"), "{}");
    if (defect === "dialect" || defect === "chain") {
      const value = JSON.parse(readFileSync(snapshot));
      if (defect === "dialect") value.dialect = "postgresql";
      else value.prevId = "unrelated-history";
      writeFileSync(snapshot, JSON.stringify(value));
    }
    let invoked = false;
    await assert.rejects(generateMigration({ root, run() { invoked = true; return { status: 0 }; } }), /docs\/DATABASE\.md/);
    assert.equal(invoked, false);
  }
});

test("an output override is validated instead of bypassing the guard", async t => {
  const { root } = fixture(t);
  await assert.rejects(generateMigration({ root, args: ["--out", "./untracked-history"],
    run() { throw new Error("Generator must not run"); } }), /Cannot read the Drizzle migration journal/);
});

test("non-numbered output cannot break runtime migration ordering", async t => {
  const { root } = fixture(t);
  await assert.rejects(generateMigration({ root, args: ["--prefix=none"],
    run() { throw new Error("Generator must not run"); } }), /runtime requires numbered migrations/);
});

test("a non-numbered configured prefix cannot be masked by a CLI index flag", async t => {
  const { root } = fixture(t, { dialect: "sqlite", out: "./migrations", migrations: { prefix: "timestamp" } });
  let invoked = false;
  const run = () => { invoked = true; return { status: 0 }; };
  await assert.rejects(generateMigration({ root, run }), /Set migrations.prefix to index/);
  assert.equal(invoked, false);
  await assert.rejects(generateMigration({ root, args: ["--prefix=index"], run }), /does not override it with --prefix/);
  assert.equal(invoked, false);
});

test("an explicit index flag works with an index-configured history", async t => {
  const { root } = fixture(t, { dialect: "sqlite", out: "./migrations", migrations: { prefix: "index" } });
  assert.equal(await generateMigration({ root, args: ["--prefix=index"], run: () => ({ status: 0 }) }), 0);
});
