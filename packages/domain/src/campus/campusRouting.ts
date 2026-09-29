// Version 1 is an illustrative network on the user-supplied 393 × 508 image.
// Coordinates are image pixels, NOT GPS or surveyed robot paths. Keep this
// network stable so existing orders retain their original simulated timeline.
export type MapPoint = { id: string; x: number; y: number };
export type MapEdge = { from: string; to: string; seconds: number };
export const PREPARATION_MS = 20_000;
export const campusNodes: MapPoint[] = [
  { id: "depot", x: 176, y: 327 },
  { id: "westSouth", x: 145, y: 302 },
  { id: "library", x: 128, y: 270 },
  { id: "westNorth", x: 143, y: 246 },
  { id: "student", x: 164, y: 225 },
  { id: "north", x: 199, y: 242 },
  { id: "eastNorth", x: 236, y: 267 },
  { id: "eastSouth", x: 236, y: 316 },
  { id: "south", x: 210, y: 329 },
  { id: "residence", x: 195, y: 351 },
];
export const campusEdges: MapEdge[] = [
  { from: "depot", to: "westSouth", seconds: 16 },
  { from: "westSouth", to: "library", seconds: 15 },
  { from: "library", to: "westNorth", seconds: 12 },
  { from: "westNorth", to: "student", seconds: 12 },
  { from: "student", to: "north", seconds: 16 },
  { from: "north", to: "eastNorth", seconds: 20 },
  { from: "eastNorth", to: "eastSouth", seconds: 22 },
  { from: "eastSouth", to: "south", seconds: 13 },
  { from: "south", to: "depot", seconds: 15 },
  { from: "south", to: "residence", seconds: 12 },
  { from: "depot", to: "residence", seconds: 18 },
];
export const meetingPoints = [
  { id: "library", label: "Library entrance", marker: "A" },
  { id: "student", label: "Student center", marker: "B" },
  { id: "residence", label: "Residence hall courtyard", marker: "C" },
];
export type CampusRoute = { nodes: MapPoint[]; segmentSeconds: number[]; seconds: number };

// Dijkstra minimizes the sum of estimated travel times, not straight-line distance.
// Return null on missing/disconnected destinations; never invent a direct path.
export function fastestRoute(destination: string, nodes = campusNodes, edges = campusEdges): CampusRoute | null {
  const end = meetingPoints.find((point) => point.label === destination)?.id ?? destination;
  if (!nodes.some((node) => node.id === end) || !nodes.some((node) => node.id === "depot")) return null;
  const remaining = new Set(nodes.map((node) => node.id));
  const distances = new Map<string, number>([["depot", 0]]);
  const previous = new Map<string, { id: string; seconds: number }>();
  while (remaining.size) {
    const current = [...remaining].sort((a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity))[0];
    const distance = distances.get(current) ?? Infinity;
    if (!Number.isFinite(distance)) break;
    remaining.delete(current);
    if (current === end) break;
    for (const edge of edges) {
      if (!Number.isFinite(edge.seconds) || edge.seconds <= 0) continue;
      const next = edge.from === current ? edge.to : edge.to === current ? edge.from : null;
      if (!next || !remaining.has(next)) continue;
      if (distance + edge.seconds < (distances.get(next) ?? Infinity)) {
        distances.set(next, distance + edge.seconds);
        previous.set(next, { id: current, seconds: edge.seconds });
      }
    }
  }
  if (!Number.isFinite(distances.get(end))) return null;
  const ids = [end];
  const segmentSeconds: number[] = [];
  while (ids[0] !== "depot") {
    const step = previous.get(ids[0]);
    if (!step) return null;
    ids.unshift(step.id);
    segmentSeconds.unshift(step.seconds);
  }
  return { nodes: ids.map((id) => nodes.find((node) => node.id === id)!), segmentSeconds, seconds: distances.get(end)! };
}

export function positionOnRoute(route: CampusRoute, elapsedSeconds: number) {
  let remaining = Math.max(0, elapsedSeconds);
  for (let index = 0; index < route.segmentSeconds.length; index++) {
    const duration = route.segmentSeconds[index];
    if (remaining < duration) {
      const start = route.nodes[index], end = route.nodes[index + 1];
      const fraction = remaining / duration;
      return { x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction };
    }
    remaining -= duration;
  }
  return route.nodes[route.nodes.length - 1];
}

export function deliveryTimeline(location: string, createdAt: number, now: number) {
  const route = fastestRoute(location);
  const departsAt = createdAt + PREPARATION_MS;
  // Preserve a fallback for legacy orders whose location is no longer supported.
  const arrivesAt = departsAt + (route?.seconds ?? 45) * 1000;
  const status = now < departsAt ? "preparing" : now < arrivesAt ? "delivering" : "delivered";
  return { departsAt, arrivesAt, status };
}
