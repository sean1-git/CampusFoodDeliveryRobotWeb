# UC Merced Campus Store

A campus shopping PWA built to help students check what's available before making a trip across campus. It includes The Summit's Marketplace, Bobcat's Snack Shop, and a robot delivery simulation.

[Try the demo](https://projectdemo-qf2f7jkpma-ew.a.run.app/)

The demo uses sample inventory and a $50 browser wallet. No school login, real payments, or physical robots are connected.

**Stack:** React, TypeScript, Vite, Material Web, Node.js, SQLite/Drizzle, Google Maps, and Capacitor.

## Run locally

Use Node.js 22.19+ or 24. From the repository root:

```sh
npm ci
npm run dev
```

Vite normally runs at [localhost:5173](http://localhost:5173); the API runs on port 8787. To test the production build and PWA instead, stop the dev server and run:

```sh
npm run build
npm start
```

Open [localhost:8787](http://localhost:8787). SQLite data lives in `.data/campus-demo.sqlite`; startup applies migrations automatically.

Set `GOOGLE_MAPS_BROWSER_KEY` in the server environment to enable the map. This is a public browser key: restrict it to Maps JavaScript API and your site's referrers. Other settings are in [.env.example](.env.example). Server scripts do not load `.env` automatically. Keep secrets out of Git and `VITE_*` variables.

## Checkout and inventory

- One bag can contain items from both shops. The server owns prices, stock, and store assignments.
- Requests enter a database FIFO queue in 100 ms ticks. The first valid request recorded gets the stock; client timestamps do not set priority. Settlement runs during requests, so 100 ms is not a response-time guarantee.
- Entering checkout holds the entire bag for five minutes. Confirmation charges the demo wallet; cancellation or expiry releases stock. Refreshing does not extend a hold.
- Transactions, ownership checks, CSRF tokens, and idempotency keys prevent overselling and duplicate charges. Each account can have one active checkout and one delivery at a time.
- Tabs share a cookie-based account. A different browser or cleared cookies creates a separate wallet; there is no verified student identity yet.

## Delivery routes

Customers confirm a campus meeting point before checkout. Google Maps displays the map; an OpenStreetMap snapshot supplies 290 connected walkway sections. Nearby selections snap onto eligible paths within 25 m. The server validates the campus boundary and an 8 m input tolerance independently.

Dijkstra finds the shortest mapped route. For mixed-store bags, the simulation compares both pickup orders. It starts at a shop, prepares for 20 seconds, stops for five seconds at each pickup, and travels at 1 m/s. Ordering opens again at the saved arrival time. Existing orders keep their route and timetable after map updates.

Stairs, restricted access, unverified barriers, and disconnected paths are excluded. Location sharing is optional and uses a single fix. Routes do not account for live obstacles or robot telemetry. See [walkway data and attribution](docs/WALKWAY_DATA.md) for coverage and import instructions.

## Offline and mobile

After an initial online visit, the production PWA caches its UI and retains the bag and last catalog snapshot. Inventory refreshes every 15 minutes, with immediate refreshes after checkout changes. Source stock-change time, backend sync time, and browser fetch time are tracked separately.

Checkout and live order updates need a connection. Purchase requests are never replayed automatically offline, and Google map tiles are not cached. Service workers are disabled during Vite development.

Android and iOS projects use Capacitor. Run `npm run native:sync` after web changes; see [NATIVE.md](NATIVE.md) for device setup, signing, and remaining map validation.

## Code and checks

| Location | Purpose |
| --- | --- |
| `src/components/`, `src/hooks/` | UI, cart, checkout, and PWA state |
| `shared/` | Catalog, walkway graph, routing, and saved-route playback |
| `server/` | Sessions, API, inventory queue, and checkout |
| `db/`, `drizzle/` | Database schema and migrations |
| `tests/` | Checkout, security, routing, offline, and PWA checks |

```sh
npm run lint
npm run build
npm test
```

Tests cover competing buyers, hold expiry, retries, account isolation, CSRF, route connectivity, and offline recovery. See [dependency maintenance](docs/DEPENDENCIES.md) for runtime packaging and pinned tooling fixes.

## Deployment limits

The Dockerfile runs the demo on Cloud Run. Keep a single instance while using local SQLite: its data is lost when the container is replaced. Scaling requires a durable shared database and revalidation of checkout transactions and triggers.

Behind HTTPS proxies, set `CANONICAL_ORIGIN` to the public origin. Proxy headers are ignored by default; enable `TRUST_PROXY` only for trusted ingress. See [.env.example](.env.example) for options.

Only `INTEGRATION_MODE=demo` is supported. School sign-in, inventory and wallet APIs, real robot dispatch, and native store releases remain future work.
