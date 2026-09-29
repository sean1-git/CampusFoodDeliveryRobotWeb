# Database changes

The API runs SQLite through Node's built-in driver. `packages/database/schema.ts`
describes tables for Drizzle tooling; the runtime applies every numbered SQL file
in `packages/database/migrations`, in filename order. It records completed files
in `_local_migrations` and rolls back a failed file. Existing files are append-only:
changing an applied file does not update databases that already recorded it.

## Current generation limit

The Drizzle journal and snapshots cover `0000`–`0002`. Handwritten migrations
`0003`–`0011` add accounts, security triggers, inventory metadata, and saved routes.
Running Drizzle generation against the old snapshots recreates existing objects;
the resulting SQL fails on the current database.

`npm run db:generate` therefore checks SQL filenames, journal entries, and the
snapshot chain before invoking Drizzle. It currently exits with an explanation
and writes nothing. It does not repair metadata or rewrite history. Ordinary
generator arguments are forwarded without a shell; alternate output paths are
checked too. Keep the default `index` filename prefix so runtime migration order
stays predictable. Do not bypass this guard by running Drizzle directly.

## Adding a migration now

1. Add a new SQL file using the next unused four-digit number and a descriptive
   suffix, for example `0012_description.sql`. Keep earlier migrations intact.
2. Update `packages/database/schema.ts` to reflect table, index, and constraint
   changes. Keep custom triggers and data backfills in SQL; the TypeScript schema
   does not describe every runtime rule.
3. Add a regression test that applies migrations to a fresh in-memory database
   and upgrades a temporary copy of the previous schema with representative rows.
   Check retained orders, balances, stock allocations, holds, and required triggers.
4. Run `npm test` and `npm run build`. Inspect the migrated `sqlite_schema` and
   `PRAGMA foreign_key_check` in the test. Verify expected columns, indexes, and
   trigger behavior; a successful SQL parse alone does not establish correctness.
5. Back up any persistent database before rollout and rehearse the upgrade on its
   copy. Never experiment against a live database or commit database files.

Deleting historical orders or allocations changes computed wallet balances and
stock. Retention needs a separate accounting plan, not a blanket cleanup query.

## Reconciliation debt

Before enabling generated migrations again, reconcile the journal and snapshots
with the full replayed schema, including all handwritten migrations. Review that
baseline in isolation and confirm that generating from unchanged `schema.ts`
produces no schema changes. Preserve the existing SQL filenames and runtime
migration records, and test both fresh setup and upgrades with data. Do not simply
add journal entries or fabricate a snapshot to make the guard pass.

The guard verifies metadata consistency, not the semantic correctness of future
SQL. Schema and upgrade tests remain required. A future move to a shared database
also requires translating SQLite transactions and triggers; PostgreSQL is not
implemented by this project.
