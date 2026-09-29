import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const guide = "See docs/DATABASE.md: reconcile migration metadata before generating SQL. Existing migrations must not be rewritten.";
const fail = message => { throw new Error(`${message}\n${guide}`); };

export function validateMigrationHistory(directory) {
  let journal;
  try { journal = JSON.parse(readFileSync(join(directory, "meta/_journal.json"), "utf8")); }
  catch { fail("Cannot read the Drizzle migration journal. Generation was stopped before writing files."); }
  if (journal.dialect !== "sqlite" || journal.version !== "7"
    || !Array.isArray(journal.entries) || !journal.entries.length)
    fail("The migration journal is not a supported SQLite history.");

  const tags = journal.entries.map((entry, index) => {
    if (entry.idx !== index || entry.version !== "6" || typeof entry.tag !== "string"
      || !entry.tag.startsWith(`${String(index).padStart(4, "0")}_`)
      || !/^\d+_[a-zA-Z0-9_-]+$/.test(entry.tag)) fail("The migration journal has an invalid or non-sequential entry.");
    return `${entry.tag}.sql`;
  });
  const sqlFiles = readdirSync(directory).filter(name => name.endsWith(".sql"));
  const unrecorded = sqlFiles.filter(name => !tags.includes(name));
  const missing = tags.filter(name => !sqlFiles.includes(name));
  if (unrecorded.length || missing.length)
    fail(`SQL files and the Drizzle journal disagree. Unrecorded SQL: ${unrecorded.join(", ") || "none"}. Missing SQL: ${missing.join(", ") || "none"}. Generation was stopped before writing files.`);

  let previousId = "00000000-0000-0000-0000-000000000000";
  const ids = new Set();
  for (const entry of journal.entries) {
    const name = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
    let snapshot;
    try { snapshot = JSON.parse(readFileSync(join(directory, "meta", name), "utf8")); }
    catch { fail(`Snapshot ${name} is missing or invalid.`); }
    if (snapshot.dialect !== "sqlite" || snapshot.version !== entry.version
      || typeof snapshot.id !== "string" || !snapshot.id || ids.has(snapshot.id)
      || snapshot.prevId !== previousId || !snapshot.tables || typeof snapshot.tables !== "object"
      || Array.isArray(snapshot.tables)) fail(`Snapshot ${name} does not match the journal's SQLite history.`);
    ids.add(snapshot.id); previousId = snapshot.id;
  }
  const snapshots = readdirSync(join(directory, "meta")).filter(name => /^\d+_snapshot\.json$/.test(name));
  if (snapshots.length !== journal.entries.length) fail("Extra or stale snapshots exist outside the journal history.");
  return { migrations: tags.length };
}

function option(args, name) {
  let value;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      value = args[++i];
      if (!value || value.startsWith("--")) fail(`A value is required for ${name}.`);
    } else if (args[i].startsWith(`${name}=`)) value = args[i].slice(name.length + 1);
  }
  return value;
}

export async function generateMigration({ args = [], root = repository, run = spawnSync } = {}) {
  const configPath = resolve(root, option(args, "--config") || "drizzle.config.ts");
  let config;
  try { config = (await import(pathToFileURL(configPath))).default; }
  catch { fail("Cannot load the Drizzle configuration. Check its path and run npm ci before generating migrations."); }
  // Installed Drizzle gives migrations.prefix precedence over --prefix when a
  // config contains it. An index CLI flag must not mask unsafe configured output.
  if (config?.migrations?.prefix !== undefined && config.migrations.prefix !== "index")
    fail("Set migrations.prefix to index in Drizzle configuration; this CLI version does not override it with --prefix.");
  const prefix = option(args, "--prefix") ?? config?.migrations?.prefix ?? "index";
  if (prefix !== "index")
    fail("The runtime requires numbered migrations. Keep Drizzle's default index prefix.");
  if ((option(args, "--dialect") || config?.dialect) !== "sqlite") fail("This migration guard supports the project's SQLite history only.");
  const output = option(args, "--out") || config?.out;
  if (typeof output !== "string" || !output) fail("The migration output directory is missing from Drizzle configuration.");
  // Inspect the actual configured output, including CLI overrides, before the
  // generator can append files. No snapshot or journal is repaired implicitly.
  validateMigrationHistory(resolve(root, output));
  const cli = join(repository, "node_modules/drizzle-kit/bin.cjs");
  if (!existsSync(cli)) fail("The installed Drizzle CLI is missing. Run npm ci first.");
  const result = run(process.execPath, [cli, "generate", ...args], {
    cwd: root, stdio: "inherit", shell: false, windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await generateMigration({ args: process.argv.slice(2) }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
