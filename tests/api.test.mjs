import test from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../server/api.mjs";
import { openDatabase } from "../server/local-db.mjs";
const origin = "https://campus.test";
const basket = {
  items: [{ id: "sandwich", quantity: 1 }],
  location: "Library entrance",
};
async function fixture(t) {
  const DB = openDatabase();
  t.after(() => DB.close());
  const env = { DB };
  async function user() {
    const response = await handleApi(new Request(origin + "/api/session"), env);
    return {
      cookie: response.headers.get("set-cookie").split(";")[0],
      ...(await response.json()),
    };
  }
  function request(
    user,
    path = "/api/orders",
    method = "GET",
    body,
    key = crypto.randomUUID(),
    extras = {},
  ) {
    return handleApi(
      new Request(origin + path, {
        method,
        headers: {
          cookie: user.cookie,
          origin,
          "content-type": "application/json",
          "x-csrf-token": user.csrf,
          "idempotency-key": key,
          ...extras,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  }
  return { env, user, request };
}
test("server prices override client prices and API responses are never cached", async (t) => {
  const f = await fixture(t),
    u = await f.user();
  const response = await f.request(u, "/api/orders", "POST", {
    ...basket,
    total: 1,
    items: [{ id: "sandwich", quantity: 1, priceCents: 1 }],
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).totalCents, 750);
  const wallet = await f.request(u, "/api/session");
  assert.equal((await wallet.json()).balanceCents, 4250);
});
test("concurrent retries create one order and one deduction", async (t) => {
  const f = await fixture(t),
    u = await f.user(),
    key = crypto.randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 6 }, () =>
      f.request(u, "/api/orders", "POST", basket, key),
    ),
  );
  const orders = await Promise.all(responses.map((r) => r.json()));
  assert.equal(new Set(orders.map((o) => o.id)).size, 1);
  assert.equal(
    (await (await f.request(u, "/api/session")).json()).balanceCents,
    4250,
  );
  assert.equal((await (await f.request(u)).json()).orders.length, 1);
});
test("same request ID cannot be reused with a different order", async (t) => {
  const f = await fixture(t),
    u = await f.user(),
    key = crypto.randomUUID();
  await f.request(u, "/api/orders", "POST", basket, key);
  const response = await f.request(
    u,
    "/api/orders",
    "POST",
    { ...basket, location: "Student center" },
    key,
  );
  assert.equal(response.status, 409);
});
test("concurrent different orders cannot overspend demo funds", async (t) => {
  const f = await fixture(t),
    u = await f.user();
  const large = { ...basket, items: [{ id: "sandwich", quantity: 5 }] };
  const responses = await Promise.all([
    f.request(u, "/api/orders", "POST", large),
    f.request(u, "/api/orders", "POST", large),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    (await (await f.request(u, "/api/session")).json()).balanceCents,
    1650,
  );
});
test("order ownership enforced for reads and lists", async (t) => {
  const f = await fixture(t),
    a = await f.user(),
    b = await f.user();
  const order = await (
    await f.request(a, "/api/orders", "POST", basket)
  ).json();
  assert.equal((await f.request(b, "/api/orders/" + order.id)).status, 404);
  assert.deepEqual((await (await f.request(b)).json()).orders, []);
});
test("invalid CSRF, cross-origin and unauthenticated checkout rejected", async (t) => {
  const f = await fixture(t),
    u = await f.user();
  assert.equal(
    (
      await f.request(u, "/api/orders", "POST", basket, crypto.randomUUID(), {
        "x-csrf-token": "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(u, "/api/orders", "POST", basket, crypto.randomUUID(), {
        origin: "https://other.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request({ ...u, cookie: "" }, "/api/orders", "POST", basket))
      .status,
    401,
  );
});
test("negative quantities, duplicate items and unknown locations rejected", async (t) => {
  const f = await fixture(t),
    u = await f.user();
  for (const body of [
    { ...basket, items: [{ id: "sandwich", quantity: -1 }] },
    { ...basket, items: [...basket.items, ...basket.items] },
    { ...basket, location: "Unknown" },
  ])
    assert.equal((await f.request(u, "/api/orders", "POST", body)).status, 400);
  assert.equal(
    (await (await f.request(u, "/api/session")).json()).balanceCents,
    5000,
  );
});
test("delivery status follows the simulated clock without another dispatch", async (t) => {
  const f = await fixture(t),
    u = await f.user();
  const order = await (
    await f.request(u, "/api/orders", "POST", basket)
  ).json();
  const request = () =>
    new Request(origin + "/api/orders/" + order.id, {
      headers: { cookie: u.cookie },
    });
  assert.equal(
    (await (await handleApi(request(), f.env, order.createdAt + 25000)).json())
      .status,
    "delivering",
  );
  assert.equal(
    (await (await handleApi(request(), f.env, order.createdAt + 70000)).json())
      .status,
    "delivered",
  );
});
test("live integration mode fails closed", async (t) => {
  const f = await fixture(t);
  const response = await handleApi(new Request(origin + "/api/session"), {
    ...f.env,
    INTEGRATION_MODE: "live",
  });
  assert.equal(response.status, 503);
});
