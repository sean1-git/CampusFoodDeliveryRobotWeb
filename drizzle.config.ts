/**
 * Tells Drizzle where the SQLite table definitions live and where to write migrations.
 */
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/database/schema.ts",
  out: "./packages/database/migrations",
});
