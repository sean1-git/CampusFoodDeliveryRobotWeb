import test from "node:test";
import assert from "node:assert/strict";
import { campusNodes, campusEdges, meetingPoints, fastestRoute, positionOnRoute, deliveryTimeline } from "../../packages/domain/src/campus/campusRouting.ts";
import { publicOrder } from "../../apps/api/src/orders/orders.mjs";
import { secureResponse } from "../../apps/api/src/http/http.mjs";

test("routing minimizes time, handles closures and never invents disconnected paths", () => {
  const route = fastestRoute("Library entrance");
  assert.equal(route.seconds, 31);
  assert.deepEqual(route.nodes.map((node) => node.id), ["depot", "westSouth", "library"]);
  const closed = campusEdges.filter((edge) => edge.to !== "westSouth");
  const detour = fastestRoute("Library entrance", campusNodes, closed);
  assert.ok(detour.seconds > route.seconds);
  assert.equal(fastestRoute("Library entrance", campusNodes, []), null);
  assert.equal(fastestRoute("Unknown meeting point"), null);
  // An extra edge is geometrically direct but slower than the multi-edge route.
  assert.equal(fastestRoute("Library entrance", campusNodes, [...campusEdges, { from: "depot", to: "library", seconds: 100 }]).seconds, 31);
});

test("all destinations interpolate along connected edges and clamp at arrival", () => {
  for (const point of meetingPoints) {
    const route = fastestRoute(point.label);
    assert.equal(route.nodes.at(-1).id, point.id);
    assert.deepEqual(positionOnRoute(route, -1), { x: 176, y: 327 });
    assert.deepEqual(positionOnRoute(route, route.seconds + 100), route.nodes.at(-1));
    const first = route.nodes[0], second = route.nodes[1];
    assert.deepEqual(positionOnRoute(route, route.segmentSeconds[0] / 2), { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });
  }
});

test("API arrival/status use the route duration and exact preparation/arrival boundaries", () => {
  const createdAt = 1_000_000;
  for (const point of meetingPoints) {
    const route = fastestRoute(point.label);
    const row = { id: "test", items: "[]", location: point.label, created_at: createdAt, subtotal: 100, total: 200 };
    const departure = createdAt + 20_000, arrival = departure + route.seconds * 1000;
    assert.equal(publicOrder(row, departure - 1).status, "preparing");
    assert.equal(publicOrder(row, departure).status, "delivering");
    assert.equal(publicOrder(row, arrival - 1).status, "delivering");
    assert.equal(publicOrder(row, arrival).status, "delivered");
    assert.equal(publicOrder(row, arrival).arrivesAt, arrival);
    assert.equal(publicOrder(row, arrival).serverNow, arrival);
  }
  assert.equal(deliveryTimeline("legacy location", createdAt, createdAt).arrivesAt, createdAt + 65000);
});

test("location is allowed only for the same origin while camera/microphone stay disabled", () => {
  const header = secureResponse(new Response("ok")).headers.get("permissions-policy");
  assert.equal(header, "camera=(), microphone=(), geolocation=(self)");
});
