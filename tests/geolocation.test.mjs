import test from "node:test";
import assert from "node:assert/strict";
import { campusStops, confirmedRoute, routeToPin, pickupRoute, geoPosition, geoTimeline } from "../shared/campusGeo.ts";
import { openDatabase } from "../server/local-db.mjs";
import { handleApi } from "../server/api.mjs";
import { studentSession } from "./student-fixture.mjs";

const destination = { lat: 37.363146, lng: -120.425201, confirmed: true };
test("geofence rejects missing, unconfirmed, malformed, outside-campus and off-path pins", () => {
  for (const p of [null, {}, { ...destination, confirmed: false }, { lat: NaN, lng: 0, confirmed: true },
    { ...destination, lat: '37.363146' }, { lat: 37.7749, lng: -122.4194, confirmed: true },
    { lat: 37.365, lng: -120.427, confirmed: true }]) assert.equal(confirmedRoute(p), null);
  for (const p of campusStops) assert.ok(confirmedRoute({ ...p, confirmed: true }));
  // Exact between-anchor pin remains the destination, including a small permitted offset.
  const mid = { lat: (campusStops[0].lat + campusStops[1].lat) / 2 + 0.00001, lng: (campusStops[0].lng + campusStops[1].lng) / 2, confirmed: true };
  assert.deepEqual(confirmedRoute(mid).destination, mid);
});
test("product store IDs determine pickups; mixed-store route chooses shortest sequence", () => {
  const single = pickupRoute(destination, ["library", "library"]);
  assert.deepEqual(single.pickups.map(p => p.id), ["library"]);
  assert.deepEqual(single.points[0], { lat: campusStops[2].lat, lng: campusStops[2].lng });
  const mixed = pickupRoute(destination, ["library", "summits"]);
  assert.deepEqual(new Set(mixed.pickups.map(p => p.id)), new Set(["library", "summits"]));
  const forward = routeToPin(campusStops[2], 0).seconds + routeToPin(destination, 2).seconds;
  const reverse = routeToPin(campusStops[0], 2).seconds + routeToPin(destination, 0).seconds;
  assert.equal(mixed.seconds, Math.min(forward, reverse));
  assert.ok(mixed.meters > single.meters);
  assert.deepEqual(geoPosition(mixed, mixed.seconds + 1), destination);
  assert.deepEqual(geoPosition(mixed, -100), mixed.points[0]);
  const timeline = geoTimeline(mixed, 100000, 100000);
  assert.equal(timeline.arrivesAt, 120000 + mixed.seconds * 1000);
  assert.equal(geoTimeline(mixed, 100000, timeline.arrivesAt).status, "delivered");
  assert.equal(pickupRoute(destination, ["forged-store"]), null);
});
test("API cannot reserve or charge without a confirmed supported pin; ignores forged route and store", async t => {
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
  const key = crypto.randomUUID();
  let response = await call("/api/reservations", { ...body, destination, deliveryRoute: { seconds: 1 } }, key);
  while (response.status === 202) { await new Promise(r => setTimeout(r, 100)); response = await call(`/api/checkouts/${key}`); }
  assert.equal((await response.json()).status, "held");
  assert.equal((await (await call("/api/session")).json()).balanceCents, 5000);
  response = await call(`/api/reservations/${key}/confirm`, {}, key);
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.deepEqual(order.deliveryRoute.destination, destination);
  assert.deepEqual(order.deliveryRoute.pickups.map(p => p.id), ["library"]);
  assert.ok(order.deliveryRoute.seconds > 1);
  assert.equal(order.arrivesAt, order.createdAt + 20000 + order.deliveryRoute.seconds * 1000);
  assert.equal((await (await call("/api/session")).json()).nextOrderAt, order.arrivesAt);
  assert.equal((await call("/api/reservations", { ...body, destination: { ...destination, ...campusStops[0] } }, key)).status, 409);
  await call(`/api/reservations/${key}/confirm`, {}, key);
  assert.equal((await (await call("/api/session")).json()).balanceCents, 4250);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM orders").first()).count, 1);
});
