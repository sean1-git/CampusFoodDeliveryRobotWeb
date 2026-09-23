/**
 * Database table definitions used by Drizzle to generate SQL migrations.
 * Sessions own orders; monetary amounts are integer cents and timestamps are milliseconds.
 */
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

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

// Stock is shared across visitors. Purchases are an append-only allocation ledger.
export const inventory = sqliteTable("inventory", {
  productId: text("product_id").primaryKey(),
  quantity: integer("quantity").notNull(),
}, (table) => [check("inventory_nonnegative", sql`${table.quantity} >= 0`)]);

export const orderItems = sqliteTable("order_items", {
  orderId: text("order_id").notNull().references(() => orders.id),
  productId: text("product_id").notNull().references(() => inventory.productId),
  quantity: integer("quantity").notNull(),
}, (table) => [
  uniqueIndex("order_items_order_product").on(table.orderId, table.productId),
  index("order_items_product").on(table.productId),
  check("order_items_positive", sql`${table.quantity} > 0`),
]);

export const checkoutQueue = sqliteTable("checkout_queue", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  requestKey: text("request_key").notNull(),
  requestHash: text("request_hash").notNull(),
  orderId: text("order_id").notNull(),
  items: text("items").notNull(),
  subtotal: integer("subtotal").notNull(),
  total: integer("total").notNull(),
  location: text("location").notNull(),
  readyAt: integer("ready_at").notNull(),
  status: text("status").notNull().default("pending"),
  kind: text("kind").notNull().default("purchase"),
  expiresAt: integer("expires_at").notNull().default(0),
}, (table) => [
  uniqueIndex("checkout_queue_session_request").on(table.sessionId, table.requestKey),
  index("checkout_queue_status_sequence").on(table.status, table.sequence),
  index("checkout_queue_status_expiry").on(table.status, table.expiresAt),
]);
