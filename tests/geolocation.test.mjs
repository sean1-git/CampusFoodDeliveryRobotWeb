import test from "node:test";
import assert from "node:assert/strict";
import {
  campusStops, pinEdges, deliveryArea, snapDeliveryPin, confirmedRoute, routeToPin,
  routeBetweenPickups, pickupRoute, geoPosition, geoTimeline, deliverySteps,
  distance, PICKUP_SECONDS, GEO_PREPARATION_MS, CORRIDOR_METERS, SNAP_METERS,
} from "../shared/campusGeo.ts";
import walkwayData from "../shared/campusWalkways.json" with { type: "json" };
import { openDatabase } from "../server/local-db.mjs";
import { handleApi } from "../server/api.mjs";
import { studentSession } from "./student-fixture.mjs";

const coordinates = ({ lat, lng }) => ({ lat, lng });
const destination = { ...snapDeliveryPin({ lat: 37.362057, lng: -120.427846 }).point, confirmed: true };

function edgePoint(a, b, fraction) {
  return {
    lat: campusStops[a].lat + fraction * (campusStops[b].lat - campusStops[a].lat),
    lng: campusStops[a].lng + fraction * (campusStops[b].lng - campusStops[a].lng),
  };
}

// Find an interior, off-center click at a measured distance from the actual
// network, without depending on any particular walkway's orientation or name.
function offsetPin(minimum, maximum) {
  for (const [a, b] of pinEdges) {
    const midpoint = edgePoint(a, b, 0.5);
    const longitudeScale = Math.cos(midpoint.lat * Math.PI / 180);
    const x = (campusStops[b].lng - campusStops[a].lng) * longitudeScale;
    const y = campusStops[b].lat - campusStops[a].lat;
    const length = Math.hypot(x, y);
    if (length < 0.0002) continue;
    for (const sign of [-1, 1]) {
      const shift = sign * (minimum + maximum) / 2 / 111195;
      const point = { lat: midpoint.lat + shift * x / length, lng: midpoint.lng - shift * y / length / longitudeScale };
      const snapped = snapDeliveryPin(point);
      if (snapped && snapped.offsetMeters > minimum && snapped.offsetMeters < maximum) return { point, snapped };
    }
  }
  assert.fail(`No campus path has an offset fixture between ${minimum} and ${maximum} meters`);
}

test("every offered mapped walkway is reachable from both store pickups", () => {
  assert.ok(pinEdges.length > 100, "The campus network must extend beyond the old hand-drawn corridors");
  for (const [a, b] of pinEdges) {
    for (const fraction of [0, 0.5, 1]) {
      const pin = { ...edgePoint(a, b, fraction), confirmed: true };
      assert.ok(deliveryArea(pin), `Missing meeting area for edge ${a}-${b}`);
      for (const start of [0, 3]) {
        const route = routeToPin(pin, start);
        assert.ok(route, `No route from pickup ${start} to edge ${a}-${b}`);
        assert.equal(route.version, walkwayData.metadata.version);
        assert.deepEqual(route.points[0], coordinates(campusStops[start]));
        assert.ok(distance(route.destination, pin) < 0.02, "An on-path pin must not jump to another walkway");
        assert.deepEqual(route.points.at(-1), coordinates(route.destination));
        assert.ok(Number.isFinite(route.seconds) && route.seconds >= 0);
      }
    }
  }
});

test("nearby clicks snap onto a path, use a bounded radius, and keep a stable confirmed coordinate", () => {
  const { point, snapped } = offsetPin(1, CORRIDOR_METERS - 1);
  assert.ok(deliveryArea(point));
  const route = confirmedRoute({ ...point, confirmed: true });
  assert.ok(route);
  assert.notDeepEqual(coordinates(route.destination), point);
  assert.deepEqual(coordinates(route.destination), snapped.point);
  assert.deepEqual(route.points.at(-1), snapped.point, "The route must end on the walkway instead of adding an off-path spur");
  assert.deepEqual(snapDeliveryPin(snapped.point).point, snapped.point);
  assert.deepEqual(confirmedRoute(route.destination).destination, route.destination);

  const farther = offsetPin(CORRIDOR_METERS + 1, SNAP_METERS - 1);
  assert.equal(deliveryArea(farther.point), null);
  assert.ok(farther.snapped.offsetMeters < SNAP_METERS);
  assert.ok(confirmedRoute({ ...farther.snapped.point, confirmed: true }));
});

test("geofence rejects missing, unconfirmed, nonfinite, outside-campus and far-off-path pins", () => {
  const malformed = [null, {}, { ...destination, lat: "37.363146" }, { lat: NaN, lng: 0 },
    { lat: Infinity, lng: -120.427 }, { lat: 37.363, lng: -Infinity }, { lat: 91, lng: 0 }];
  for (const pin of malformed) {
    assert.equal(snapDeliveryPin(pin), null);
    assert.equal(routeToPin(pin), null);
    assert.equal(confirmedRoute(pin), null);
  }
  assert.equal(confirmedRoute({ ...destination, confirmed: false }), null);
  assert.equal(confirmedRoute(coordinates(destination)), null);
  // San Francisco, west of the campus boundary, and the unmapped eastern grounds.
  for (const pin of [{ lat: 37.7749, lng: -122.4194 }, { lat: 37.364, lng: -120.433 },
    { lat: 37.3637, lng: -120.4185 }]) {
    assert.equal(snapDeliveryPin(pin), null);
    assert.equal(deliveryArea(pin), null);
    assert.equal(confirmedRoute({ ...pin, confirmed: true }), null);
  }
  for (const start of [-1, 0.5, campusStops.length, NaN]) assert.equal(routeToPin(destination, start), null);
});

test("disconnected mapped paths are not silently bridged to the delivery network", () => {
  const offeredNodes = new Set(pinEdges.flat().map(index => campusStops[index].id));
  const isolated = walkwayData.nodes.filter(node => !offeredNodes.has(node.id));
  assert.ok(isolated.length, "The fixture includes disconnected mapped paths");
  let distantIsolatedNodes = 0;
  for (const point of isolated) {
    if (snapDeliveryPin(point)) continue; // A nearby connected path may be a legitimate alternative meeting point.
    distantIsolatedNodes++;
    assert.equal(deliveryArea(point), null);
    assert.equal(pickupRoute({ ...point, confirmed: true }, ["summits", "library"]), null);
  }
  assert.ok(distantIsolatedNodes > 0, "At least one disconnected path must remain unavailable");
  const isolatedPath = { lat: 37.3617817, lng: -120.41778635 };
  assert.equal(snapDeliveryPin(isolatedPath), null);
  assert.equal(routeToPin(isolatedPath), null);
});

test("store ownership determines pickups and unknown stores cannot create a route", () => {
  const single = pickupRoute(destination, ["library", "library"]);
  assert.deepEqual(single.pickups.map(p => p.id), ["library"]);
  const mixed = pickupRoute(destination, ["library", "summits"]);
  assert.deepEqual(new Set(mixed.pickups.map(p => p.id)), new Set(["library", "summits"]));
  assert.ok(mixed.seconds >= single.seconds);
  assert.deepEqual(geoPosition(mixed, mixed.seconds + 1), mixed.destination);
  assert.deepEqual(geoPosition(mixed, -100), mixed.points[0]);
  const timeline = geoTimeline(mixed, 100000, 100000);
  assert.equal(timeline.arrivesAt, 120000 + mixed.seconds * 1000);
  assert.equal(geoTimeline(mixed, 100000, timeline.arrivesAt).status, "delivered");
  assert.equal(pickupRoute(destination, []), null);
  assert.equal(pickupRoute(destination, ["forged-store"]), null);
  assert.equal(pickupRoute(destination, ["library", "forged-store"]), null);
});

test("each store dispatches from its supplied pickup coordinate", () => {
  for (const [id, point] of [
    ["summits", { lat: 37.363352, lng: -120.429973 }],
    ["library", { lat: 37.366145, lng: -120.424243 }],
  ]) {
    const route = pickupRoute(destination, [id]);
    assert.deepEqual(route.points[0], point);
    assert.deepEqual(route.pickups.map(store => store.id), [id]);
  }
  assert.deepEqual(routeBetweenPickups(0, 3).points.at(-1), coordinates(campusStops[3]));
  assert.deepEqual(routeBetweenPickups(3, 0).points.at(-1), coordinates(campusStops[0]));
});

test("mixed pickup ETA compares both sequences and pauses at each loading stop", () => {
  const route = pickupRoute(destination, ["summits", "library"]);
  const forward = routeBetweenPickups(0, 3).seconds + routeToPin(destination, 3).seconds + 2 * PICKUP_SECONDS;
  const reverse = routeBetweenPickups(3, 0).seconds + routeToPin(destination, 0).seconds + 2 * PICKUP_SECONDS;
  assert.equal(route.seconds, Math.min(forward, reverse));
  assert.deepEqual(route.pickups.map(p => p.id), forward <= reverse ? ["summits", "library"] : ["library", "summits"]);
  for (let i = 0; i < route.pickups.length; i++) {
    const stop = route.pickups[i];
    assert.equal(stop.departureSeconds - stop.arrivalSeconds, PICKUP_SECONDS);
    assert.deepEqual(geoPosition(route, stop.arrivalSeconds + 2), route.journey[i].points[0]);
  }
  assert.equal(route.journey.at(-1).startsAtSeconds, route.pickups.at(-1).departureSeconds);
  assert.deepEqual(geoPosition(route, route.seconds + 1), route.destination);
});

test("mixed-order progress completes both pickups before the final delivery stage", () => {
  const route = pickupRoute(destination, ["summits", "library"]), created = 1000, departure = created + GEO_PREPARATION_MS;
  const current = now => deliverySteps(route, created, now).find(s => s.state === "current").label;
  assert.equal(current(created), "Preparing");
  assert.match(current(departure), /^Pickup 1/);
  assert.match(current(departure + route.pickups[0].departureSeconds * 1000), /^Pickup 2/);
  assert.equal(current(departure + route.pickups[1].departureSeconds * 1000), "Delivering to your pin");
  assert.equal(current(departure + route.seconds * 1000), "Delivered");
  assert.equal(deliverySteps(pickupRoute(destination, ["summits"]), created, created).length, 4);
});

test("historical v6 orders retain their frozen geometry and timing after the map changes", () => {
  const points = [{ lat: 37.366402, lng: -120.423777 }, { lat: 37.366502, lng: -120.423777 }];
  const saved = { version: "ucm-simulation-v6", destination: { ...points[1], confirmed: true },
    label: "Previously confirmed destination", points, meters: 11, seconds: 12 };
  const serialized = JSON.stringify(saved);
  assert.deepEqual(geoPosition(saved, 0), points[0]);
  const midway = geoPosition(saved, distance(points[0], points[1]) / 2);
  assert.ok(distance(midway, { lat: 37.366452, lng: -120.423777 }) < 0.01);
  assert.deepEqual(geoPosition(saved, 1000), points[1]);
  assert.equal(geoTimeline(saved, 1000, 33000).status, "delivered");
  assert.equal(geoTimeline(saved, 1000, 1000).arrivesAt, 33000);
  assert.equal(JSON.stringify(saved), serialized);
});

test("API validates and snaps the pin, ignores forged route/store, and keeps retries idempotent", async t => {
  const DB = openDatabase(); t.after(() => DB.close()); const user = await studentSession(DB);
  const call = (path, body, key = crypto.randomUUID()) => handleApi(new Request(`https://campus.test${path}`, {
    method: body ? "POST" : "GET", headers: { cookie: user.cookie, origin: "https://campus.test", "content-type": "application/json", "x-csrf-token": user.csrf, "idempotency-key": key },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { DB });
  const body = { items: [{ id: "sandwich", quantity: 1, storeId: "summits" }], location: "any client label" };
  for (const path of ["/api/orders", "/api/reservations"]) {
    for (const pin of [undefined, { ...destination, confirmed: false }, { lat: 0, lng: 0, confirmed: true }]) {
      assert.equal((await call(path, { ...body, destination: pin })).status, 400);
    }
  }
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM checkout_queue").first()).count, 0);
  assert.equal((await (await call("/api/session")).json()).balanceCents, 5000);
  const { point, snapped } = offsetPin(1, CORRIDOR_METERS - 1);
  const requested = { ...point, confirmed: true }, canonical = { ...snapped.point, confirmed: true };
  const key = crypto.randomUUID();
  let response = await call("/api/reservations", { ...body, destination: requested, deliveryRoute: { seconds: 1 } }, key);
  while (response.status === 202) { await new Promise(r => setTimeout(r, 100)); response = await call(`/api/checkouts/${key}`); }
  assert.equal((await response.json()).status, "held");
  assert.equal((await (await call("/api/session")).json()).balanceCents, 5000);
  response = await call(`/api/reservations/${key}/confirm`, {}, key);
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.deepEqual(order.deliveryRoute.destination, canonical);
  assert.deepEqual(order.deliveryRoute.points.at(-1), snapped.point);
  assert.deepEqual(order.deliveryRoute.pickups.map(p => p.id), ["library"]);
  assert.ok(order.deliveryRoute.seconds > 1);
  assert.equal(order.arrivesAt, order.createdAt + GEO_PREPARATION_MS + order.deliveryRoute.seconds * 1000);
  assert.equal((await (await call("/api/session")).json()).nextOrderAt, order.arrivesAt);
  // Retries must preserve the submitted point, even when the server snaps it.
  response = await call("/api/reservations", { ...body, destination: requested }, key);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, order.id);
  assert.equal((await call("/api/reservations", { ...body, destination: canonical }, key)).status, 409);
  const changed = { ...snapDeliveryPin(campusStops[3]).point, confirmed: true };
  assert.equal((await call("/api/reservations", { ...body, destination: changed }, key)).status, 409);
  await call(`/api/reservations/${key}/confirm`, {}, key);
  assert.equal((await (await call("/api/session")).json()).balanceCents, 4250);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM orders").first()).count, 1);
});

test("retrying a historical hold or order preserves its frozen route after map eligibility changes", async t => {
  const DB = openDatabase(); t.after(() => DB.close()); const user = await studentSession(DB);
  const call = (path, body, key = crypto.randomUUID()) => handleApi(new Request(`https://campus.test${path}`, {
    method: body ? "POST" : "GET", headers: { cookie: user.cookie, origin: "https://campus.test", "content-type": "application/json", "x-csrf-token": user.csrf, "idempotency-key": key },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { DB });
  const body = { items: [{ id: "sandwich", quantity: 1 }], destination };
  const key = crypto.randomUUID();
  let response = await call("/api/reservations", body, key);
  while (response.status === 202) { await new Promise(r => setTimeout(r, 100)); response = await call(`/api/checkouts/${key}`); }
  assert.equal((await response.json()).status, "held");

  // Simulate an earlier map snapshot that supported a now-unavailable location.
  // Neither a retry nor confirmation may replace the stored route with a new one.
  const oldDestination = { lat: 37.3637, lng: -120.4185, confirmed: true };
  assert.equal(confirmedRoute(oldDestination), null);
  const held = await DB.prepare("SELECT * FROM checkout_queue WHERE request_key = ?").bind(key).first();
  const fingerprint = JSON.parse(held.request_hash);
  fingerprint.destination = oldDestination;
  const saved = JSON.parse(held.delivery_route);
  const points = [coordinates(campusStops[3]), coordinates(oldDestination)];
  const frozenRoute = { ...saved, version: "ucm-simulation-v6", destination: oldDestination,
    label: "Legacy campus pin", points, meters: 600, seconds: 600 + PICKUP_SECONDS,
    journey: [{ points, seconds: 600, startsAtSeconds: PICKUP_SECONDS }] };
  await DB.prepare("UPDATE checkout_queue SET request_hash = ?, delivery_route = ?, location = ? WHERE request_key = ?")
    .bind(JSON.stringify(fingerprint), JSON.stringify(frozenRoute), frozenRoute.label, key).run();
  const originalBody = { ...body, destination: oldDestination };
  response = await call("/api/reservations", originalBody, key);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "held");
  assert.equal((await (await call("/api/session")).json()).balanceCents, 5000);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM checkout_queue").first()).count, 1);

  response = await call(`/api/reservations/${key}/confirm`, {}, key);
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.deepEqual(order.deliveryRoute, frozenRoute);
  assert.equal(order.arrivesAt, order.createdAt + GEO_PREPARATION_MS + frozenRoute.seconds * 1000);
  response = await call("/api/reservations", originalBody, key);
  assert.equal(response.status, 200);
  const retried = await response.json();
  assert.equal(retried.id, order.id);
  assert.deepEqual(retried.deliveryRoute, frozenRoute);
  assert.equal((await (await call("/api/session")).json()).balanceCents, 4250);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM orders").first()).count, 1);
  assert.equal((await DB.prepare("SELECT SUM(quantity) AS count FROM order_items").first()).count, 1);
  // Only the already accepted request can resume; a new ID cannot reuse a stale pin.
  assert.equal((await call("/api/reservations", originalBody)).status, 400);
});
