// Versioned pedestrian geometry is shared by the lazy map and authoritative checkout.
import data from "./campusWalkways.json" with { type: "json" };
import { storeName } from "../catalog/stores.ts";
import { coordinate, distance, PICKUP_SECONDS, ROBOT_METERS_PER_SECOND } from "../delivery/deliveryRoute.ts";
import type { Coordinate, DeliveryPin, GeoRoute } from "../delivery/deliveryRoute.ts";
export * from "../delivery/deliveryRoute.ts";

export const CORRIDOR_METERS = 8;
export const SNAP_METERS = 25;
export const campusBoundary: Coordinate[] = data.boundary.map(([lat, lng]) => ({ lat, lng }));
const anchors = [
  { id: "summit-pickup", label: "Summit demo pickup", lat: 37.363352, lng: -120.429973 },
  { id: "bobcat-pickup", label: "Bobcat demo pickup", lat: 37.366145, lng: -120.424243 },
];
export const pickupStores = [
  { id: "library", name: storeName("library"), node: 3 },
  { id: "summits", name: storeName("summits"), node: 0 },
];
export function insideCampus(value: unknown): value is Coordinate {
  if (!coordinate(value)) return false;
  let inside = false;
  for (let i = 0, j = campusBoundary.length - 1; i < campusBoundary.length; j = i++) {
    const a = campusBoundary[j], b = campusBoundary[i];
    if (distance(value, project(value, a, b)) < 0.01) return true;
    if ((a.lat > value.lat) !== (b.lat > value.lat) && value.lng <
      (b.lng - a.lng) * (value.lat - a.lat) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}
function project(p: Coordinate, a: Coordinate, b: Coordinate): Coordinate {
  const scale = Math.cos(a.lat * Math.PI / 180);
  const x = (b.lng - a.lng) * scale, y = b.lat - a.lat, squared = x * x + y * y;
  const t = squared ? Math.max(0, Math.min(1, (((p.lng - a.lng) * scale) * x + (p.lat - a.lat) * y) / squared)) : 0;
  return { lat: a.lat + t * y, lng: a.lng + t * (b.lng - a.lng) };
}
type Segment = { a: number; b: number; name: string; available: boolean };
function nearestSegment(value: Coordinate, segments: Segment[], nodes: Coordinate[]) {
  let best: (Segment & { point: Coordinate; offsetMeters: number }) | null = null;
  for (const segment of segments) {
    const point = project(value, nodes[segment.a], nodes[segment.b]);
    const offsetMeters = distance(value, point);
    if (!best || offsetMeters < best.offsetMeters) best = { ...segment, point, offsetMeters };
  }
  return best;
}
const edgeKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
const pathLabel = (name: string) => name === "Scholar's Lane" ? "Scholars Lane" : name;
const names = new Map<string, string>();
for (const path of data.paths) for (let i = 1; i < path.nodes.length; i++) {
  const key = edgeKey(path.nodes[i - 1], path.nodes[i]);
  if (!names.has(key) || path.name !== "Campus walkway") names.set(key, pathLabel(path.name));
}
const rawSegments = data.edges.map(([a, b]) => ({ a, b, name: names.get(edgeKey(a, b)) ?? "Campus walkway", available: true }));
const storeEntries = anchors.map(anchor => nearestSegment(anchor, rawSegments, data.nodes)!);
const rawNeighbors: number[][] = data.nodes.map(() => []);
for (const [a, b] of data.edges) { rawNeighbors[a].push(b); rawNeighbors[b].push(a); }
const connected = new Set<number>([storeEntries[0].a]);
const queue = [...connected];
for (let i = 0; i < queue.length; i++) for (const next of rawNeighbors[queue[i]]) {
  if (!connected.has(next)) { connected.add(next); queue.push(next); }
}
// Never invent links between nearby disconnected paths. The only off-path links
// are short simulated access legs to the two user-supplied store pickup anchors.
const storesConnected = storeEntries.every(entry => entry.offsetMeters <= CORRIDOR_METERS && connected.has(entry.a));
export const campusStops = [
  anchors[0], { id: "summit-entry", label: "Summit walkway", ...storeEntries[0].point },
  { id: "bobcat-entry", label: "Bobcat walkway", ...storeEntries[1].point }, anchors[1],
  ...data.nodes.map(node => ({ ...node, label: "Campus walkway" })),
];
const segments: Segment[] = [];
for (const raw of rawSegments) {
  const available = storesConnected && connected.has(raw.a);
  const splits = storeEntries.flatMap((entry, index) => edgeKey(entry.a, entry.b) === edgeKey(raw.a, raw.b)
    ? [{ node: index === 0 ? 1 : 2, meters: distance(data.nodes[raw.a], entry.point) }] : []);
  const nodes = [raw.a + 4, ...splits.sort((a, b) => a.meters - b.meters).map(s => s.node), raw.b + 4];
  for (let i = 1; i < nodes.length; i++) segments.push({ a: nodes[i - 1], b: nodes[i], name: raw.name, available });
}
export const pinEdges = segments.filter(s => s.available).map(({ a, b }) => [a, b]);
export const geoEdges = storesConnected ? [...pinEdges, [0, 1], [3, 2]] : [];
export const walkwayPaths = data.paths.filter(path => storesConnected && path.nodes.every(node => connected.has(node)))
  .map(path => ({ id: path.id, name: pathLabel(path.name), points: path.nodes.map(node => ({ lat: data.nodes[node].lat, lng: data.nodes[node].lng })) }));
export const walkwayMetadata = { ...data.metadata, availablePathCount: walkwayPaths.length,
  availableEdgeCount: pinEdges.length, availableNodeCount: connected.size, fetchedAt: data.metadata.snapshotDate };
export const pinCorridors = [...new Set(segments.filter(s => s.available).map(s => s.name))].map(name => ({
  name, edges: segments.filter(s => s.available && s.name === name).map(({ a, b }) => [a, b]),
}));
// A short keyboard-accessible list complements clicking any highlighted path.
export const walkwayChoices = pinCorridors.filter(c => c.name !== "Campus walkway").map(c => {
  const [a, b] = c.edges[Math.floor(c.edges.length / 2)];
  return { id: c.name, label: c.name, lat: (campusStops[a].lat + campusStops[b].lat) / 2,
    lng: (campusStops[a].lng + campusStops[b].lng) / 2 };
}).sort((a, b) => a.label.localeCompare(b.label));
function locatePin(value: unknown, tolerance: number) {
  if (!insideCampus(value)) return null;
  const nearest = nearestSegment(value, segments, campusStops);
  // Isolated walkways cannot silently snap across gaps to a different component.
  return nearest?.available && nearest.offsetMeters <= tolerance ? nearest : null;
}
export function snapDeliveryPin(value: unknown) {
  const nearest = locatePin(value, SNAP_METERS);
  return nearest ? { point: nearest.point, label: nearest.name, offsetMeters: nearest.offsetMeters } : null;
}
export function deliveryArea(value: unknown) { return locatePin(value, CORRIDOR_METERS)?.name ?? null; }

const adjacency: { node: number; meters: number }[][] = campusStops.map(() => []);
for (const [a, b] of geoEdges) {
  const meters = distance(campusStops[a], campusStops[b]);
  adjacency[a].push({ node: b, meters }); adjacency[b].push({ node: a, meters });
}
type SearchTree = { costs: number[]; previous: number[] };
const storeTrees = new Map<number, SearchTree>();
// Binary-heap Dijkstra runs once per store. On-edge destinations reuse its tree.
function searchFrom(start: number): SearchTree {
  const cached = storeTrees.get(start);
  if (cached) return cached;
  const costs = campusStops.map(() => Infinity), previous = campusStops.map(() => -1);
  const heap: { node: number; cost: number }[] = [];
  function push(entry: { node: number; cost: number }) {
    let index = heap.length; heap.push(entry);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].cost <= entry.cost) break;
      heap[index] = heap[parent]; index = parent;
    }
    heap[index] = entry;
  }
  function pop() {
    const first = heap[0], tail = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (2 * index + 1 < heap.length) {
        let child = 2 * index + 1;
        if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost) child++;
        if (heap[child].cost >= tail.cost) break;
        heap[index] = heap[child]; index = child;
      }
      heap[index] = tail;
    }
    return first;
  }
  costs[start] = 0; push({ node: start, cost: 0 });
  while (heap.length) {
    const { node, cost } = pop();
    if (cost > costs[node]) continue;
    for (const next of adjacency[node]) {
      const candidate = cost + next.meters;
      if (candidate < costs[next.node]) {
        costs[next.node] = candidate; previous[next.node] = node; push({ node: next.node, cost: candidate });
      }
    }
  }
  const tree = { costs, previous };
  if (start === 0 || start === 3) storeTrees.set(start, tree);
  return tree;
}
function pathTo(start: number, end: number, tree: SearchTree): Coordinate[] | null {
  if (!Number.isFinite(tree.costs[end])) return null;
  const indices = [end];
  while (indices.at(-1) !== start) {
    const prior = tree.previous[indices.at(-1)!];
    if (prior < 0) return null;
    indices.push(prior);
  }
  return indices.reverse().map(index => ({ lat: campusStops[index].lat, lng: campusStops[index].lng }));
}
function buildRoute(point: Coordinate, label: string, points: Coordinate[], meters: number): GeoRoute {
  return { version: data.metadata.version, destination: { ...point, confirmed: true }, label, points,
    meters: Math.round(meters), seconds: Math.ceil(meters / ROBOT_METERS_PER_SECOND) };
}
export function routeToPin(value: unknown, start = 0): GeoRoute | null {
  if (!Number.isInteger(start) || start < 0 || start >= campusStops.length) return null;
  const nearest = locatePin(value, CORRIDOR_METERS);
  if (!nearest) return null;
  const tree = searchFrom(start);
  const costA = tree.costs[nearest.a] + distance(campusStops[nearest.a], nearest.point);
  const costB = tree.costs[nearest.b] + distance(campusStops[nearest.b], nearest.point);
  const end = costA <= costB ? nearest.a : nearest.b;
  const points = pathTo(start, end, tree);
  if (!points) return null;
  points.push(nearest.point);
  // The server also snaps; there is no customer-supplied final off-path spur.
  return buildRoute(nearest.point, nearest.name, points, Math.min(costA, costB));
}
export function routeBetweenPickups(start: number, target: number): GeoRoute | null {
  if (![0, 3].includes(start) || ![0, 3].includes(target) || !storesConnected) return null;
  const tree = searchFrom(start), points = pathTo(start, target, tree);
  return points ? buildRoute({ lat: campusStops[target].lat, lng: campusStops[target].lng }, campusStops[target].label, points, tree.costs[target]) : null;
}
export function confirmedRoute(value: unknown): GeoRoute | null {
  return (value as DeliveryPin | null)?.confirmed === true ? routeToPin(value) : null;
}
export function pickupRoute(value: unknown, storeIds: string[]): GeoRoute | null {
  if ((value as DeliveryPin | null)?.confirmed !== true || !deliveryArea(value) || !storeIds.length) return null;
  const stores = [...new Set(storeIds)].map(id => pickupStores.find(store => store.id === id));
  if (stores.some(store => !store)) return null;
  const sequences = stores.length === 2 ? [stores, [...stores].reverse()] : [stores];
  const candidates: GeoRoute[] = [];
  for (const sequence of sequences) {
    const legs = sequence.slice(1).map((store, i) => routeBetweenPickups(sequence[i]!.node, store!.node));
    legs.push(routeToPin(value, sequence.at(-1)!.node));
    // Incomplete map data fails closed rather than joining gaps or crashing checkout.
    if (legs.some(leg => !leg)) continue;
    const validLegs = legs as GeoRoute[], last = validLegs.at(-1)!;
    let elapsed = 0;
    const pickups = sequence.map((store, index) => {
      const arrivalSeconds = elapsed;
      elapsed += PICKUP_SECONDS;
      const departureSeconds = elapsed;
      elapsed += validLegs[index].seconds;
      return { id: store!.id, name: store!.name, arrivalSeconds, departureSeconds };
    });
    // Freeze geometry and stop times so later map edits never reroute saved orders.
    const journey = validLegs.map((leg, index) => ({ points: leg.points, seconds: leg.seconds, startsAtSeconds: pickups[index].departureSeconds }));
    candidates.push({ ...last, points: validLegs.flatMap((leg, index) => index ? leg.points.slice(1) : leg.points),
      meters: validLegs.reduce((sum, leg) => sum + leg.meters, 0), seconds: elapsed, pickups, journey });
  }
  return candidates.sort((a, b) => a.seconds - b.seconds)[0] ?? null;
}
