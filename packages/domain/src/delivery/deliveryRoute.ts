// Saved route playback deliberately has no dependency on the current map dataset.
export type Coordinate = { lat: number; lng: number };
export type DeliveryPin = Coordinate & { confirmed: true };
export type GeoRoute = { version: string; destination: DeliveryPin; label: string; points: Coordinate[]; meters: number; seconds: number; pickups?: { id: string; name: string; arrivalSeconds?: number; departureSeconds?: number; items?: { name: string; quantity: number }[] }[]; journey?: { points: Coordinate[]; seconds: number; startsAtSeconds: number }[] };

export const GEO_PREPARATION_MS = 20000;
export const PICKUP_SECONDS = 5;
export const ROBOT_METERS_PER_SECOND = 1;
export function distance(a: Coordinate, b: Coordinate): number {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export function coordinate(value: unknown): value is Coordinate {
  const p = value as Coordinate | null;
  return !!p && typeof p.lat === "number" && typeof p.lng === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lng)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}
export function geoPosition(route: GeoRoute, seconds: number): Coordinate {
  // New orders pause at each pickup. Older saved routes keep their original animation.
  if (route.journey) {
    for (const leg of route.journey) {
      if (seconds < leg.startsAtSeconds) return leg.points[0];
      if (seconds < leg.startsAtSeconds + leg.seconds) {
        const length = leg.points.slice(1).reduce((sum, point, i) => sum + distance(leg.points[i], point), 0);
        return positionAlong(leg.points, length * (seconds - leg.startsAtSeconds) / leg.seconds);
      }
    }
    return route.destination;
  }
  return positionAlong(route.points, Math.max(0, seconds) * ROBOT_METERS_PER_SECOND);
}
function positionAlong(points: Coordinate[], remaining: number): Coordinate {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], length = distance(a, b);
    if (length > 0 && remaining < length) return { lat: a.lat + (b.lat - a.lat) * remaining / length, lng: a.lng + (b.lng - a.lng) * remaining / length };
    remaining -= length;
  }
  return points.at(-1)!;
}
export function geoTimeline(route: GeoRoute, createdAt: number, now: number) {
  const departsAt = createdAt + GEO_PREPARATION_MS, arrivesAt = departsAt + route.seconds * 1000;
  return { departsAt, arrivesAt, status: now < departsAt ? "preparing" : now < arrivesAt ? "delivering" : "delivered" };
}

export function deliverySteps(route: GeoRoute, createdAt: number, now: number) {
  const departure = createdAt + GEO_PREPARATION_MS;
  const pickups = route.pickups?.filter(p => p.arrivalSeconds !== undefined && p.departureSeconds !== undefined) ?? [];
  const steps = [
    { label: "Preparing", startsAt: createdAt },
    ...pickups.map((p, i) => ({ label: `Pickup ${i + 1} · ${p.name}`,
      startsAt: departure + (i === 0 ? 0 : pickups[i - 1].departureSeconds!) * 1000 })),
    { label: "Delivering to your pin", startsAt: departure + (pickups.at(-1)?.departureSeconds ?? 0) * 1000 },
    { label: "Delivered", startsAt: departure + route.seconds * 1000 },
  ];
  const activeIndex = steps.reduce((active, step, i) => now >= step.startsAt ? i : active, 0);
  return steps.map((step, i) => ({ ...step, state: i < activeIndex ? "complete" : i === activeIndex ? "current" : "upcoming" }));
}
