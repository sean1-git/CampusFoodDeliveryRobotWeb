/**
 * Shared TypeScript descriptions of products, cart quantities, sessions, and orders.
 * These help catch coding mistakes; the server still validates incoming requests.
 */
import type sampleCatalog from "../shared/catalog.json";

export type Product = (typeof sampleCatalog.products)[number] & {
  stock?: number;
  stockUpdatedAt?: number | null;
  syncedAt?: number | null;
};
export type Catalog = Omit<typeof sampleCatalog, "products"> & { products: Product[]; responseGeneratedAt?: number | null };
export type QueuedCheckout = { status: "pending"; requestKey: string; retryAfterMs: number };
export type HeldCheckout = { status: "held"; requestKey: string; expiresAt: number; serverNow: number };
export type Reservation = Pending & {
  expiresAt: number;
  clockOffsetMs: number;
  phase: "reserving" | "held" | "confirming" | "cancelling";
};
export type Cart = Record<string, number>;
export type Session = {
  csrf: string;
  accountId: string;
  balanceCents: number;
  nextOrderAt: number | null;
  mode: string;
};
export type Order = {
  id: string;
  items: { id: string; name: string; priceCents: number; quantity: number }[];
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  location: string;
  createdAt: number;
  arrivesAt: number;
  status: "preparing" | "delivering" | "delivered";
};
export type Pending = {
  key: string;
  body: { items: { id: string; quantity: number }[]; location: string };
};
