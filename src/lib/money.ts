/**
 * Formats integer cents as US dollars for display; calculations keep using cents.
 */
export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
