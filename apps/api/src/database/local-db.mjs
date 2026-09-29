/**
 * Opens SQLite and applies each generated SQL migration once.
 * Wraps queries in the database interface also used by the worker API; tests can use memory.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

// Bound ad-hoc SQL retention while reusing the API's recurring queries.
const STATEMENT_CACHE_SIZE = 128;

export function openDatabase(filename = ":memory:") {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)",
  );
  const directory = new URL("../../../../packages/database/migrations/", import.meta.url);
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
  const statementCache = new Map();
  function statementFor(sql) {
    let statement = statementCache.get(sql);
    if (statement) statementCache.delete(sql);
    else statement = sqlite.prepare(sql);
    statementCache.set(sql, statement);
    if (statementCache.size > STATEMENT_CACHE_SIZE)
      statementCache.delete(statementCache.keys().next().value);
    return statement;
  }
  function prepared(statement, args = []) {
    return {
      // Bindings belong to each wrapper, never to the cached statement. Pending
      // requests and transaction batches can safely share SQL with different args.
      bind: (...values) => prepared(statement, values),
      first: async () => statement.get(...args) ?? null,
      all: async () => ({ results: statement.all(...args) }),
      run: async () => statement.run(...args),
      // Synchronous execution keeps all statements inside one local transaction.
      execute: () => ({ results: statement.all(...args) }),
    };
  }
  return {
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql) {
      return prepared(statementFor(sql));
    },
    close() {
      statementCache.clear();
      sqlite.close();
    },
  };
}
