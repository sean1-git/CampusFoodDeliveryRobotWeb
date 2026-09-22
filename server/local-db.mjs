/**
 * Opens SQLite and applies each generated SQL migration once.
 * Wraps queries in the database interface also used by the worker API; tests can use memory.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

export function openDatabase(filename = ":memory:") {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)",
  );
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(directory)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    if (
      sqlite
        .prepare("SELECT name FROM _local_migrations WHERE name = ?")
        .get(name)
    )
      continue;
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
      sqlite
        .prepare("INSERT INTO _local_migrations (name) VALUES (?)")
        .run(name);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            first: async () => statement.get(...args) ?? null,
            all: async () => ({ results: statement.all(...args) }),
            run: async () => statement.run(...args),
          };
        },
      };
    },
    close: () => sqlite.close(),
  };
}
