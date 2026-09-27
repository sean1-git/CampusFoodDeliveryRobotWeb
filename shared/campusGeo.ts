// Customer pin corridors and a separate demo-only travel network.
// Replace this versioned network with surveyed sidewalk geometry before real dispatch.
import { storeName } from "./stores.ts";
export type Coordinate = { lat: number; lng: number };
export type DeliveryPin = Coordinate & { confirmed: true };
export type GeoRoute = { version: string; destination: DeliveryPin; label: string; points: Coordinate[]; meters: number; seconds: number; pickups?: { id: string; name: string }[] };
// Pickup anchors stay independent of the customer meeting corridors.
export const campusStops = [
  { id: "summit-pickup", label: "Summit demo pickup", lat: 37.363352, lng: -120.429973 },
  { id: "scholars-west", label: "Scholars Lane · west", lat: 37.363323, lng: -120.430034 },
  { id: "scholars-bend", label: "Scholars Lane · bend", lat: 37.363322, lng: -120.428197 },
  { id: "bobcat-pickup", label: "Bobcat demo pickup", lat: 37.366145, lng: -120.424243 },
  { id: "scholars-turn", label: "Scholars Lane · turn", lat: 37.363441, lng: -120.427897 },
  { id: "scholars-mid", label: "Scholars Lane · central", lat: 37.364781, lng: -120.426052 },
  { id: "scholars-east", label: "Scholars Lane · east", lat: 37.365562, lng: -120.424938 },
  { id: "mammoth-north", label: "Mammoth Lakes Road · north", lat: 37.364389, lng: -120.429165 },
  { id: "mammoth-south", label: "Mammoth Lakes Road · south", lat: 37.363468, lng: -120.429144 },
  { id: "university-north", label: "University Avenue · north", lat: 37.363311, lng: -120.427830 },
  { id: "university-south", label: "University Avenue · south", lat: 37.362057, lng: -120.427846 },
];
export const pinCorridors = [
  { name: "Scholars Lane", edges: [[1, 2], [2, 4], [4, 5], [5, 6]] },
  { name: "Mammoth Lakes Road", edges: [[7, 8]] },
  { name: "University Avenue", edges: [[9, 10]] },
];
export const pinEdges = pinCorridors.flatMap(c => c.edges);
// These connectors are animation estimates only, not robot navigation instructions.
export const geoEdges = [...pinEdges, [0, 1], [3, 6], [8, 2], [9, 4]];
// Only customer corridors authorize a meeting point; animation connectors never do.
export function deliveryArea(value: unknown) {
  if (!coordinate(value)) return null;
  const nearest = pinCorridors.flatMap(c => c.edges.map(([a, b]) => ({
    name: c.name, offset: distance(value, project(value, campusStops[a], campusStops[b]))
  }))).sort((a, b) => a.offset - b.offset)[0];
  return nearest.offset <= CORRIDOR_METERS ? nearest.name : null;
}
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
// Dijkstra runs on the small demo graph. Costs remain unrounded until the final ETA.
function shortestPath(nodes: Coordinate[], edges: number[][], start: number, destination: number) {
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
  return { indices, seconds: costs[destination] };
}

// Dijkstra weights are expected travel seconds. The destination splits its nearest
// edge; an exact selected pin is retained, never silently replaced by a landmark.
function simulatedRoute(value: unknown, start = 0): GeoRoute | null {
  if (!coordinate(value)) return null;
  const nearest = geoEdges.map(([a, b]) => {
    const point = project(value, campusStops[a], campusStops[b]);
    return { a, b, point, offset: distance(value, point) };
  }).sort((a, b) => a.offset - b.offset)[0];

  // Split the closest edge, then retain the exact pin as a final short segment.
  const nodes: Coordinate[] = [...campusStops, nearest.point, { lat: value.lat, lng: value.lng }];
  const junction = campusStops.length, destination = junction + 1;
  if (!Number.isInteger(start) || start < 0 || start >= campusStops.length) return null;
  const edges: [number, number][] = geoEdges.filter(([a, b]) => a !== nearest.a || b !== nearest.b).map(([a, b]) => [a, b]);
  edges.push([nearest.a, junction], [junction, nearest.b], [junction, destination]);
  const path = shortestPath(nodes, edges, start, destination);
  if (!path) return null;
  const closest = [...campusStops].sort((a, b) => distance(value, a) - distance(value, b))[0];
  return { version: "ucm-simulation-v3", destination: { lat: value.lat, lng: value.lng, confirmed: true },
    label: deliveryArea(value) ?? closest.label, points: path.indices.map(i => ({ lat: nodes[i].lat, lng: nodes[i].lng })),
    meters: Math.round(path.seconds * ROBOT_METERS_PER_SECOND), seconds: Math.ceil(path.seconds) };
}
export function routeToPin(value: unknown, start = 0): GeoRoute | null {
  return deliveryArea(value) ? simulatedRoute(value, start) : null;
}
export function confirmedRoute(value: unknown): GeoRoute | null {
  return (value as DeliveryPin | null)?.confirmed === true ? routeToPin(value) : null;
}
export function pickupRoute(value: unknown, storeIds: string[]): GeoRoute | null {
  // Validate once; each candidate route uses the same confirmed destination.
  if ((value as DeliveryPin | null)?.confirmed !== true || !deliveryArea(value) || !storeIds.length) return null;
  const stores = [...new Set(storeIds)].map(id => pickupStores.find(s => s.id === id));
  if (stores.some(s => !s)) return null;
  // The demo starts at a pickup store. For a mixed bag, compare both pickup
  // sequences using Dijkstra legs; the lower total travel time wins.
  const sequences = stores.length === 2 ? [stores, [...stores].reverse()] : [stores];
  const candidates = sequences.map(sequence => {
    const legs = sequence.slice(1).map((s, i) => simulatedRoute(campusStops[s!.node], sequence[i]!.node)!);
    legs.push(simulatedRoute(value, sequence.at(-1)!.node)!);
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
