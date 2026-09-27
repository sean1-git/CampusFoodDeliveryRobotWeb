import test from "node:test";
import assert from "node:assert/strict";
import { campusStops, pinEdges, deliveryArea, confirmedRoute, routeToPin, pickupRoute, geoPosition, geoTimeline } from "../shared/campusGeo.ts";
import { openDatabase } from "../server/local-db.mjs";
import { handleApi } from "../server/api.mjs";
import { studentSession } from "./student-fixture.mjs";

const destination = { lat: 37.362057, lng: -120.427846, confirmed: true };
test("all meeting corridors accept exact pins and reject off-corridor locations", () => {
  for (const [a, b] of pinEdges) {
    for (const fraction of [0, 0.17, 0.5, 0.83, 1]) {
      const pin = { lat: campusStops[a].lat + fraction * (campusStops[b].lat - campusStops[a].lat),
        lng: campusStops[a].lng + fraction * (campusStops[b].lng - campusStops[a].lng), confirmed: true };
      const route = confirmedRoute(pin);
      assert.ok(route, `Rejected a pin on edge ${a}-${b}`);
      assert.deepEqual(route.destination, pin);
      assert.equal(route.version, "ucm-simulation-v6");
    }
  }
  assert.equal(routeToPin({ lat: 37.3638186, lng: -120.4259624 }), null);
  assert.equal(deliveryArea({ lat: 37.366402, lng: -120.423777 }), "Northeast campus path");
  assert.equal(routeToPin({ lat: 37.366402, lng: -120.422777 }), null);
});
test("geofence rejects missing, unconfirmed, malformed, outside-campus and off-path pins", () => {
  for (const p of [null, {}, { ...destination, confirmed: false }, { lat: NaN, lng: 0, confirmed: true },
    { ...destination, lat: '37.363146' }, { lat: 37.7749, lng: -122.4194, confirmed: true },
    { lat: 37.365, lng: -120.427, confirmed: true }]) assert.equal(confirmedRoute(p), null);
  for (const i of new Set(pinEdges.flat())) assert.ok(confirmedRoute({ ...campusStops[i], confirmed: true }));
  // Exact between-anchor pin remains the destination, including a small permitted offset.
  const mid = { lat: (campusStops[1].lat + campusStops[2].lat) / 2 + 0.00001, lng: (campusStops[1].lng + campusStops[2].lng) / 2, confirmed: true };
  assert.deepEqual(confirmedRoute(mid).destination, mid);
});
test("product store IDs determine pickups; mixed-store route chooses shortest sequence", () => {
  const single = pickupRoute(destination, ["library", "library"]);
  assert.deepEqual(single.pickups.map(p => p.id), ["library"]);
  assert.deepEqual(single.points[0], { lat: campusStops[3].lat, lng: campusStops[3].lng });
  const mixed = pickupRoute(destination, ["library", "summits"]);
  assert.deepEqual(new Set(mixed.pickups.map(p => p.id)), new Set(["library", "summits"]));
  assert.ok(mixed.seconds >= single.seconds);
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
  assert.equal((await call("/api/reservations", { ...body, destination: { ...destination, ...campusStops[1] } }, key)).status, 409);
  await call(`/api/reservations/${key}/confirm`, {}, key);
  assert.equal((await (await call("/api/session")).json()).balanceCents, 4250);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM orders").first()).count, 1);
});

test("meeting validation excludes simulated connectors and preserves Summit dispatch", () => {
  assert.equal(deliveryArea({lat: 37.3639, lng: -120.429155}), "Mammoth Lakes Road");
  assert.equal(deliveryArea({lat: 37.3627, lng: -120.427838}), "University Avenue");
  // The newly supplied northeast corridor now includes the Bobcat pickup.
  assert.equal(deliveryArea(campusStops[3]), "Northeast campus path");
  assert.equal(deliveryArea({lat:37.363395,lng:-120.429}), null);
  const route = pickupRoute(destination, ["summits"]);
  assert.deepEqual(route.points[0], {lat: campusStops[0].lat, lng: campusStops[0].lng});
  assert.deepEqual(route.pickups.map(p => p.id), ["summits"]);
});

test("each store dispatches from its supplied pickup coordinate", () => {
  for (const [id, point] of [
    ["summits", {lat: 37.363352, lng: -120.429973}],
    ["library", {lat: 37.366145, lng: -120.424243}],
  ]) {
    const route = pickupRoute(destination, [id]);
    assert.deepEqual(route.points[0], point);
    assert.deepEqual(route.pickups.map(store => store.id), [id]);
  }
});

test("new campus path is reachable from either pickup without opening nearby off-path areas", () => {
  for (const stop of campusStops.slice(11, 17)) {
    for (const id of ["summits", "library"]) {
      const route = pickupRoute({...stop, confirmed: true}, [id]);
      assert.ok(route);
      assert.deepEqual(route.destination, {lat:stop.lat,lng:stop.lng,confirmed:true});
      assert.equal(route.pickups[0].id, id);
    }
  }
  assert.equal(deliveryArea({lat:37.363986,lng:-120.423903}), null);
});

test("new northwest and northeast segments support both pickups without joining the gap", () => {
  for (const [a,b] of [[17,18],[19,20]]) {
    for (const fraction of [0,.5,1]) {
      const pin = {lat:campusStops[a].lat + fraction*(campusStops[b].lat-campusStops[a].lat),lng:campusStops[a].lng+fraction*(campusStops[b].lng-campusStops[a].lng),confirmed:true};
      for (const store of ["summits","library"]) {
        const route=pickupRoute(pin,[store]);
        assert.ok(route);
        assert.deepEqual(route.destination,pin);
        assert.equal(route.pickups[0].id,store);
      }
    }
  }
  assert.equal(deliveryArea({lat:(campusStops[18].lat+campusStops[19].lat)/2,lng:(campusStops[18].lng+campusStops[19].lng)/2}),null);
});

test("separate northeast link and east path accept pins from either store", () => {
  for (const [a,b] of [[21,22],[23,24]]) {
    for (const t of [0,.5,1]) {
      const pin={lat:campusStops[a].lat+t*(campusStops[b].lat-campusStops[a].lat),lng:campusStops[a].lng+t*(campusStops[b].lng-campusStops[a].lng),confirmed:true};
      for (const store of ["summits","library"]) {
        const route=pickupRoute(pin,[store]);
        assert.ok(route);
        assert.deepEqual(route.destination,pin);
        assert.deepEqual(route.pickups.map(p=>p.id),[store]);
      }
    }
  }
  assert.equal(deliveryArea({lat:37.364672,lng:-120.423443}),null);
});
