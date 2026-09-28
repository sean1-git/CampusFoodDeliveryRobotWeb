// Offline OSM importer: preserve mapped node topology; never bridge nearby lines.
const PUBLIC_FOOT = new Set(["yes", "designated", "permissive", "official"]);
const RESTRICTED = new Set(["no", "private", "customers", "permit", "destination", "agricultural", "forestry", "delivery", "military", "use_sidepath", "discouraged"]);
const DEFAULT_WALKABLE = new Set(["footway", "path", "pedestrian"]);
const EXPLICIT_WALKABLE = new Set(["cycleway", "service", "living_street"]);

function decode(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity) => {
    if (entity.startsWith("#")) return String.fromCodePoint(entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[entity];
  });
}
function attributes(source) {
  return Object.fromEntries([...source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1], decode(match[2] ?? match[3])]));
}
export function parseOsm(xml) {
  if (!/<osm\b/.test(xml) || !/<\/osm>/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Expected an OSM XML map response without external entities.");
  const nodes = new Map(), ways = [];
  for (const match of xml.matchAll(/<(node|way)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const data = attributes(match[2]), body = match[3] ?? "";
    const tags = Object.fromEntries([...body.matchAll(/<tag\b([^>]*?)\/>/g)].map(tag => { const item = attributes(tag[1]); return [item.k, item.v]; }));
    if (match[1] === "node") {
      const lat = Number(data.lat), lng = Number(data.lon);
      if (!data.id || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("Invalid OSM coordinate.");
      nodes.set(data.id, { id: data.id, lat, lng, tags });
    } else ways.push({ id: data.id, tags, refs: [...body.matchAll(/<nd\b([^>]*?)\/>/g)].map(nd => attributes(nd[1]).ref) });
  }
  return { nodes, ways };
}

function restrictedFoot(tags) {
  return RESTRICTED.has(tags.foot) || (!PUBLIC_FOOT.has(tags.foot) && RESTRICTED.has(tags.access));
}
export function walkableWay(tags) {
  if (restrictedFoot(tags) || tags.area === "yes" || tags.indoor && tags.indoor !== "no" || tags.highway === "steps" || tags.highway === "construction"
    || tags.construction && tags.construction !== "no" || tags.proposed || tags["access:conditional"] || tags["foot:conditional"]
    || tags.wheelchair === "no" || tags.barrier && tags.barrier !== "no") return false;
  return DEFAULT_WALKABLE.has(tags.highway) || EXPLICIT_WALKABLE.has(tags.highway) && PUBLIC_FOOT.has(tags.foot);
}
export function passableNode(tags) {
  if (restrictedFoot(tags) || tags.locked === "yes" || tags.entrance === "staircase" || tags.highway === "steps" || tags.wheelchair === "no") return false;
  if (!tags.barrier || tags.barrier === "no") return true;
  if (tags.barrier === "kerb") return ["lowered", "flush", "no"].includes(tags.kerb);
  // Foot access alone does not establish robot clearance through a gate or bollard.
  return PUBLIC_FOOT.has(tags.foot) && tags.wheelchair === "yes";
}

const epsilon = 1e-12;
function cross(a, b, c) { return (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng); }
function onSegment(p, a, b) {
  return Math.abs(cross(a, b, p)) < epsilon && p.lng >= Math.min(a.lng, b.lng) - epsilon && p.lng <= Math.max(a.lng, b.lng) + epsilon
    && p.lat >= Math.min(a.lat, b.lat) - epsilon && p.lat <= Math.max(a.lat, b.lat) + epsilon;
}
export function insideBoundary(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(point, a, b)) return true;
    if ((a.lat > point.lat) !== (b.lat > point.lat) && point.lng < (b.lng - a.lng) * (point.lat - a.lat) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}
export function segmentInsideBoundary(a, b, ring) {
  if (!insideBoundary(a, ring) || !insideBoundary(b, ring)) return false;
  const dx = b.lng - a.lng, dy = b.lat - a.lat, squared = dx * dx + dy * dy;
  if (squared === 0) return true;
  const cuts = [0, 1];
  // Split at every boundary crossing, including vertices and collinear sections.
  // Midpoints of each resulting interval detect exits from a concave polygon.
  for (let i = 1; i < ring.length; i++) {
    const c = ring[i - 1], d = ring[i], ex = d.lng - c.lng, ey = d.lat - c.lat, denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) > epsilon) {
      const t = ((c.lng - a.lng) * ey - (c.lat - a.lat) * ex) / denominator;
      const u = ((c.lng - a.lng) * dy - (c.lat - a.lat) * dx) / denominator;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    } else for (const p of [c, d]) if (onSegment(p, a, b)) cuts.push(((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / squared);
  }
  cuts.sort((x, y) => x - y);
  return cuts.every((value, i) => i === 0 || insideBoundary({ lat: a.lat + dy * (value + cuts[i - 1]) / 2, lng: a.lng + dx * (value + cuts[i - 1]) / 2 }, ring));
}

export function graphComponents(nodes, edges) {
  const neighbors = nodes.map(() => []);
  edges.forEach(([a, b]) => { neighbors[a].push(b); neighbors[b].push(a); });
  const visited = new Set(), components = [];
  for (let start = 0; start < nodes.length; start++) {
    if (visited.has(start)) continue;
    const queue = [start]; visited.add(start);
    for (let i = 0; i < queue.length; i++) for (const next of neighbors[queue[i]]) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    components.push(queue);
  }
  return components.sort((a, b) => b.length - a.length);
}

export function importWalkways(xml, options = {}) {
  const { nodes: sourceNodes, ways } = parseOsm(xml);
  const rawBounds = attributes(xml.match(/<bounds\b([^>]*?)\/>/)?.[1] ?? "");
  const extractBounds = Object.keys(rawBounds).length ? { south: Number(rawBounds.minlat), north: Number(rawBounds.maxlat), west: Number(rawBounds.minlon), east: Number(rawBounds.maxlon) } : null;
  const boundaryWay = ways.find(way => way.id === (options.boundaryWayId ?? "170555864"));
  if (!boundaryWay || boundaryWay.tags.amenity !== "university" || boundaryWay.refs.length < 4 || boundaryWay.refs[0] !== boundaryWay.refs.at(-1)) throw new Error("The complete closed UC Merced university boundary is required.");
  const boundary = boundaryWay.refs.map(id => sourceNodes.get(id));
  if (boundary.some(node => !node)) throw new Error("Campus boundary references missing OSM nodes; retrieve the full boundary first.");
  const runs = [], exclusions = { unsupportedWays: 0, outsideSegments: 0, blockedSegments: 0, missingSegments: 0 };
  for (const way of ways) {
    if (!walkableWay(way.tags)) { if (way.tags.highway) exclusions.unsupportedWays++; continue; }
    let run = [], section = 0;
    const flush = () => { if (run.length > 1) runs.push({ id: `osm-way-${way.id}-${section++}`, osmWayId: way.id, name: way.tags.name || "Campus walkway", ids: run }); run = []; };
    for (let i = 1; i < way.refs.length; i++) {
      const a = sourceNodes.get(way.refs[i - 1]), b = sourceNodes.get(way.refs[i]);
      if (!a || !b) { exclusions.missingSegments++; flush(); continue; }
      if (!passableNode(a.tags) || !passableNode(b.tags)) { exclusions.blockedSegments++; flush(); continue; }
      if (!segmentInsideBoundary(a, b, boundary)) { exclusions.outsideSegments++; flush(); continue; }
      if (a.id === b.id || a.lat === b.lat && a.lng === b.lng) { flush(); continue; }
      if (!run.length) run.push(a.id);
      run.push(b.id);
    }
    flush();
  }
  const nodeIds = [...new Set(runs.flatMap(path => path.ids))].sort((a, b) => Number(a) - Number(b));
  const nodeIndex = new Map(nodeIds.map((id, index) => [id, index]));
  const nodes = nodeIds.map(id => { const { lat, lng } = sourceNodes.get(id); return { id: `osm-node-${id}`, lat, lng }; });
  const paths = runs.map(({ ids, ...path }) => ({ ...path, nodes: ids.map(id => nodeIndex.get(id)) }));
  const uniqueEdges = new Map();
  for (const path of paths) for (let i = 1; i < path.nodes.length; i++) {
    const a = path.nodes[i - 1], b = path.nodes[i]; uniqueEdges.set(`${Math.min(a, b)}:${Math.max(a, b)}`, [a, b]);
  }
  const edges = [...uniqueEdges.values()], components = graphComponents(nodes, edges);
  return { metadata: { version: "ucm-osm-walkways-v1", source: "OpenStreetMap", sourceUrl: "https://www.openstreetmap.org", attribution: "© OpenStreetMap contributors", license: "ODbL-1.0", licenseUrl: "https://www.openstreetmap.org/copyright", boundaryWayId: boundaryWay.id,
    ...(extractBounds ? { extractBounds, extractUrl: `https://api.openstreetmap.org/api/0.6/map?bbox=${extractBounds.west},${extractBounds.south},${extractBounds.east},${extractBounds.north}` } : {}),
    ...(options.snapshotDate ? { snapshotDate: options.snapshotDate } : {}),
    bounds: { south: Math.min(...boundary.map(p => p.lat)), north: Math.max(...boundary.map(p => p.lat)), west: Math.min(...boundary.map(p => p.lng)), east: Math.max(...boundary.map(p => p.lng)) },
    nodeCount: nodes.length, edgeCount: edges.length, pathCount: paths.length, componentSizes: components.map(component => component.length), exclusions,
    limitations: "Mapped pedestrian connectivity for a campus simulation. Not surveyed robot clearance, live closure information, or autonomous navigation instructions." },
    boundary: boundary.map(({ lat, lng }) => [lat, lng]), nodes, edges, paths };
}
