// Stable IDs are the pickup-store link for demo products and future school data.
// "library" is retained for compatibility with existing Bobcat/library orders.
export const stores = [
  { id: "summits", name: "The Summit's Marketplace", icon: "🛒", description: "Everyday bites, refreshing drinks & late-study essentials." },
  { id: "library", name: "Bobcat's Snack shop", icon: "🐾", description: "Library study fuel, quick lunches & a little something sweet." },
];
export const storeName = (id: string) => stores.find(store => store.id === id)?.name ?? "Campus store";
