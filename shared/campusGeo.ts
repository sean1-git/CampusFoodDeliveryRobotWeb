// Simulation only: the user's ordered Scholars Lane walkway loop.
// Replace this versioned network with surveyed sidewalk geometry before real dispatch.
import { storeName } from "./stores.ts";
export type Coordinate = { lat: number; lng: number };
export type DeliveryPin = Coordinate & { confirmed: true };
export type GeoRoute = { version: string; destination: DeliveryPin; label: string; points: Coordinate[]; meters: number; seconds: number; pickups?: { id: string; name: string }[] };
export const campusStops = [
  { id: "scholars", label: "Scholars Lane", lat: 37.363452, lng: -120.427793 },
  { id: "south", label: "Loop point A · South", lat: 37.362167, lng: -120.426683 },
  { id: "east", label: "Loop point B · East", lat: 37.363970, lng: -120.424219 },
  { id: "north", label: "Loop point C · North", lat: 37.364864, lng: -120.425233 },
  { id: "west", label: "Loop point D · West", lat: 37.364640, lng: -120.425884 },
];
export const geoEdges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]] as const;
export const GEO_PREPARATION_MS = 20000;
export const CORRIDOR_METERS = 8;
export const ROBOT_METERS_PER_SECOND = 1;
export const pickupStores = [
  { id: "library", name: storeName("library"), node: 3 },
  { id: "summits", name: storeName("summits"), node: 0 },
];
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
function project(p: Coordinate, a: Coordinate, b: Coordinate) {
  const scale = Math.cos(a.lat * Math.PI / 180);
  const x = (b.lng - a.lng) * scale, y = b.lat - a.lat;
  const t = Math.max(0, Math.min(1, (((p.lng - a.lng) * scale) * x + (p.lat - a.lat) * y) / (x * x + y * y)));
  return { lat: a.lat + t * y, lng: a.lng + t * (b.lng - a.lng) };
}
// Dijkstra weights are expected travel seconds. The destination splits its nearest
// edge; an exact selected pin is retained, never silently replaced by a landmark.
export function routeToPin(value: unknown, start = 0): GeoRoute | null {
  if (!coordinate(value)) return null;
  // Conservative service envelope, not a claim to represent the legal campus boundary.
  if (value.lat < 37.3620 || value.lat > 37.3650 || value.lng < -120.4280 || value.lng > -120.4240) return null;
  const nearest = geoEdges.map(([a, b]) => {
    const point = project(value, campusStops[a], campusStops[b]);
    return { a, b, point, offset: distance(value, point) };
  }).sort((a, b) => a.offset - b.offset)[0];
  if (nearest.offset > CORRIDOR_METERS) return null;
  const nodes: Coordinate[] = [...campusStops, nearest.point, { lat: value.lat, lng: value.lng }];
  const junction = campusStops.length, destination = junction + 1;
  if (!Number.isInteger(start) || start < 0 || start >= campusStops.length) return null;
  const edges: [number, number][] = geoEdges.filter(([a, b]) => a !== nearest.a || b !== nearest.b).map(([a, b]) => [a, b]);
  edges.push([nearest.a, junction], [junction, nearest.b], [junction, destination]);
  const costs = nodes.map(() => Infinity), previous = nodes.map(() => -1), visited = new Set<number>();
  costs[start] = 0;
  while (visited.size < nodes.length) {
    let current = -1;
    nodes.forEach((_, i) => { if (!visited.has(i) && (current === -1 || costs[i] < costs[current])) current = i; });
    if (current === -1 || !Number.isFinite(costs[current])) return null;
    if (current === destination) break;
    visited.add(current);
    for (const [a, b] of edges) {
      const next = a === current ? b : b === current ? a : -1;
      if (next < 0 || visited.has(next)) continue;
      const cost = costs[current] + distance(nodes[current], nodes[next]) / ROBOT_METERS_PER_SECOND;
      if (cost < costs[next]) { costs[next] = cost; previous[next] = current; }
    }
  }
  const indices = [destination];
  while (indices[0] !== start) { const prev = previous[indices[0]]; if (prev < 0) return null; indices.unshift(prev); }
  const closest = [...campusStops].sort((a, b) => distance(value, a) - distance(value, b))[0];
  return { version: "ucm-simulation-v2", destination: { lat: value.lat, lng: value.lng, confirmed: true },
    label: closest.label, points: indices.map(i => ({ lat: nodes[i].lat, lng: nodes[i].lng })),
    meters: Math.round(costs[destination] * ROBOT_METERS_PER_SECOND), seconds: Math.ceil(costs[destination]) };
}
export function confirmedRoute(value: unknown): GeoRoute | null {
  return (value as DeliveryPin | null)?.confirmed === true ? routeToPin(value) : null;
}
export function pickupRoute(value: unknown, storeIds: string[]): GeoRoute | null {
  if (!confirmedRoute(value) || !storeIds.length) return null;
  const stores = [...new Set(storeIds)].map(id => pickupStores.find(s => s.id === id));
  if (stores.some(s => !s)) return null;
  // The demo starts at a pickup store. For a mixed bag, compare both pickup
  // sequences using Dijkstra legs; the lower total travel time wins.
  const sequences = stores.length === 2 ? [stores, [...stores].reverse()] : [stores];
  const candidates = sequences.map(sequence => {
    const legs = sequence.slice(1).map((s, i) => routeToPin(campusStops[s!.node], sequence[i]!.node)!);
    legs.push(routeToPin(value, sequence.at(-1)!.node)!);
    const last = legs.at(-1)!;
    return { ...last, points: legs.flatMap((leg, i) => i ? leg.points.slice(1) : leg.points),
      meters: legs.reduce((sum, leg) => sum + leg.meters, 0), seconds: legs.reduce((sum, leg) => sum + leg.seconds, 0),
      pickups: sequence.map(s => ({ id: s!.id, name: s!.name })) };
  });
  return candidates.sort((a, b) => a.seconds - b.seconds)[0];
}
export function geoPosition(route: GeoRoute, seconds: number): Coordinate {
  let remaining = Math.max(0, seconds) * ROBOT_METERS_PER_SECOND;
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i], length = distance(a, b);
    if (length > 0 && remaining < length) return { lat: a.lat + (b.lat - a.lat) * remaining / length, lng: a.lng + (b.lng - a.lng) * remaining / length };
    remaining -= length;
  }
  return route.destination;
}
export function geoTimeline(route: GeoRoute, createdAt: number, now: number) {
  const departsAt = createdAt + GEO_PREPARATION_MS, arrivesAt = departsAt + route.seconds * 1000;
  return { departsAt, arrivesAt, status: now < departsAt ? "preparing" : now < arrivesAt ? "delivering" : "delivered" };
}
