import test from "node:test";
import assert from "node:assert/strict";
import data from "../../packages/domain/src/campus/campusWalkways.json" with { type: "json" };
import { importWalkways, parseOsm, walkableWay, passableNode, insideBoundary, segmentInsideBoundary, graphComponents } from "../../tooling/data/lib/walkway-import.mjs";

const node = (id, lat, lng, tags = "") => `<node id="${id}" lat="${lat}" lon="${lng}">${tags}</node>`;
const tag = (k, v) => `<tag k="${k}" v="${v}"/>`;
const way = (id, refs, tags) => `<way id="${id}">${refs.map(ref => `<nd ref="${ref}"/>`).join("")}${tags}</way>`;
function fixture(nodes, ways) {
  return `<osm>${node(1, 0, 0)}${node(2, 0, 10)}${node(3, 10, 10)}${node(4, 10, 0)}${nodes}${way(170555864, [1, 2, 3, 4, 1], tag("amenity", "university"))}${ways}</osm>`;
}
test("walkway import keeps pedestrian access while excluding stairs, restricted and non-linear features", () => {
  for (const tags of [{ highway: "footway" }, { highway: "path" }, { highway: "pedestrian" }, { highway: "cycleway", foot: "designated" }, { highway: "service", access: "private", foot: "yes" }]) assert.equal(walkableWay(tags), true);
  for (const tags of [{ highway: "steps", foot: "yes" }, { highway: "path", foot: "no" }, { highway: "path", access: "private" }, { highway: "path", area: "yes" }, { highway: "path", indoor: "corridor" }, { highway: "service" }, { highway: "cycleway" }, { highway: "path", construction: "yes" }, { highway: "path", "foot:conditional": "yes @ (daytime)" }]) assert.equal(walkableWay(tags), false);
  assert.equal(passableNode({ barrier: "gate" }), false);
  assert.equal(passableNode({ barrier: "gate", foot: "yes" }), false);
  assert.equal(passableNode({ barrier: "gate", foot: "yes", wheelchair: "yes" }), true);
  assert.equal(passableNode({ barrier: "gate", foot: "yes", wheelchair: "yes", locked: "yes" }), false);
  assert.equal(passableNode({ barrier: "kerb", kerb: "lowered" }), true);
});
test("unverified barriers split ways and mapped crossing lines never gain invented junctions", () => {
  const xml = fixture(
    node(10, 1, 1) + node(11, 1, 3) + node(12, 1, 5, tag("barrier", "gate")) + node(13, 1, 7) + node(14, 1, 9) + node(15, 0.5, 2) + node(16, 9.5, 2),
    way(100, [10, 11, 12, 13, 14], tag("highway", "footway")) + way(101, [15, 16], tag("highway", "path")),
  );
  const result = importWalkways(xml);
  assert.equal(result.paths.length, 3);
  assert.equal(result.edges.length, 3);
  assert.equal(graphComponents(result.nodes, result.edges).length, 3);
  assert.equal(result.nodes.some(n => n.id === "osm-node-12"), false);
  assert.equal(result.metadata.exclusions.blockedSegments, 2);
  assert.deepEqual(result.paths.filter(p => p.osmWayId === "100").map(p => p.id), ["osm-way-100-0", "osm-way-100-1"]);
});
test("campus clipping excludes outside edges and detects concave boundary exits", () => {
  const ring = [[0, 0], [0, 6], [6, 6], [6, 4], [2, 4], [2, 3], [6, 3], [6, 0], [0, 0]].map(([lat, lng]) => ({ lat, lng }));
  assert.equal(insideBoundary({ lat: 3, lng: 3.5 }, ring), false);
  // Both endpoints and the midpoint are inside; a narrow notch still cuts the line.
  assert.equal(segmentInsideBoundary({ lat: 3, lng: 1 }, { lat: 3, lng: 4.5 }, ring), false);
  assert.equal(segmentInsideBoundary({ lat: 1, lng: 1 }, { lat: 1, lng: 5 }, ring), true);
  const result = importWalkways(fixture(node(10, 1, 1) + node(11, 1, 11), way(100, [10, 11], tag("highway", "path"))));
  assert.equal(result.edges.length, 0);
  assert.equal(result.metadata.exclusions.outsideSegments, 1);
});
test("import requires a complete campus boundary and strips OSM contributor metadata", () => {
  assert.throws(() => importWalkways("<osm></osm>"), /boundary/);
  assert.throws(() => parseOsm('<!DOCTYPE osm [<!ENTITY x SYSTEM "file:///secret">]><osm></osm>'), /entities/);
  const xml = fixture(node(10, 1, 1) + node(11, 1, 2), way(100, [10, 11], tag("highway", "path") + tag("name", "Research &amp; Learning Walk"))).replace('id="10"', 'id="10" user="private-name" uid="123"');
  const result = importWalkways(xml);
  assert.equal(result.paths[0].name, "Research & Learning Walk");
  assert.equal(JSON.stringify(result).includes("private-name"), false);
  assert.deepEqual(importWalkways(xml), result);
});
test("committed graph is fully inside the university boundary and retains source topology", () => {
  const boundary = data.boundary.map(([lat, lng]) => ({ lat, lng }));
  assert.ok(data.metadata.extractBounds.west <= data.metadata.bounds.west);
  assert.ok(data.metadata.extractBounds.east >= data.metadata.bounds.east);
  assert.ok(data.metadata.extractBounds.south <= data.metadata.bounds.south);
  assert.ok(data.metadata.extractBounds.north >= data.metadata.bounds.north);
  assert.equal(new Set(data.nodes.map(node => node.id)).size, data.nodes.length);
  for (const [a, b] of data.edges) {
    assert.ok(data.nodes[a] && data.nodes[b] && a !== b);
    assert.ok(segmentInsideBoundary(data.nodes[a], data.nodes[b], boundary));
  }
  const edges = new Set(data.edges.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));
  assert.equal(edges.size, data.edges.length);
  for (const path of data.paths) {
    assert.match(path.osmWayId, /^\d+$/);
    for (let i = 1; i < path.nodes.length; i++) {
      const a = path.nodes[i - 1], b = path.nodes[i];
      assert.ok(edges.has(`${Math.min(a, b)}:${Math.max(a, b)}`));
    }
  }
  assert.deepEqual(graphComponents(data.nodes, data.edges).map(c => c.length), data.metadata.componentSizes);
});
