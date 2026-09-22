/**
 * Database table definitions used by Drizzle to generate SQL migrations.
 * Sessions own orders; monetary amounts are integer cents and timestamps are milliseconds.
 */
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  csrf: text("csrf").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    items: text("items").notNull(),
    subtotal: integer("subtotal").notNull(),
    total: integer("total").notNull(),
    location: text("location").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    // One order per session/request ID, even if multiple retries arrive together.
    uniqueIndex("orders_session_request").on(table.sessionId, table.requestKey),
  ],
);
