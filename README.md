# Campus Store PWA

A React + TypeScript campus-store prototype with a Node/SQLite demo API. All products, funds, and robot delivery statuses are simulated. It does not connect to the school or dispatch robots.

## Run locally

Open a terminal in `C:\Users\sean.lee\OneDrive\ProjectDemo\campus-store`.

```powershell
npm install
npm run build
npm start
```

Open http://localhost:8787/ to try the production build and PWA. Node 22.19.0 was used for validation. Node may print an experimental SQLite warning.

For editing with live reload, stop the running demo server with Ctrl+C, then run:

```powershell
npm run dev
```

This starts the API on port 8787 and Vite normally on port 5173. Read the terminal for the actual Vite URL. If an API server is already running, use `npm run dev:web` to start only Vite. Changes to the backend require restarting a server started with `npm start`.

## Temporary Google Cloud Run deployment

The included `Dockerfile` builds the app for Cloud Run. After installing and authenticating the Google Cloud CLI, select project `projectdemo-509505` and deploy with a single instance while this demo uses local SQLite:

```powershell
gcloud config set project projectdemo-509505
gcloud run deploy campus-store-demo --source . --region us-west1 --allow-unauthenticated --max 1 --min 1
```

This is suitable for a temporary demo only. The SQLite file is inside the container, so orders disappear if Cloud Run replaces the instance. A durable deployment should move orders and inventory to Cloud SQL or another managed database before production use.

## PWA behavior

The production build includes a web manifest, icons, and a service worker. Service workers are deliberately disabled in the Vite development build. Open the production URL while online first so the app can cache its static files. Then the sample menu and saved bag remain available when the server cannot be reached. Checkout and current order status require the API; payment requests are never queued for offline replay.

Use the app's Install app control for browser-specific guidance. Browser support determines whether an installation prompt appears. Public installation requires HTTPS; localhost is suitable for development. An Update app message appears when a new production version is ready.

## Where to edit

| File or folder | Purpose |
| --- | --- |
| `src/App.tsx` | Assembles the page and application notices |
| `src/components/` | Store header, menu, shopping bag, and order history |
| `src/hooks/useCampusStore.ts` | Cart state, checkout, and order refresh |
| `src/hooks/usePwa.ts` | Installation and update controls |
| `src/lib/` | API requests, saved cart, and money formatting |
| `src/App.css` | Responsive visual styling |
| `shared/catalog.json` | Sample products, prices, and locations |
| `server/api.mjs` | API routes and demo sessions |
| `server/orders.mjs` | Validates checkout, calculates prices, and creates demo orders |
| `server/http.mjs` | JSON responses, request limits, and response headers |
| `server/local.mjs` | Local HTTP server |
| `server/worker.mjs` | Worker deployment entry point |
| `db/schema.ts` and `drizzle/` | Database schema and generated migration |
| `scripts/build-pwa.mjs` | Generates the production service worker |
| `tests/` | API and PWA checks |

Demo order data is stored locally in `.data/campus-demo.sqlite`. Demo sessions use cookies; there is no school login. Cart contents are stored in the browser. Each session starts with $50 in simulated funds. A demo delivery costs $1, and order progress is simulated over roughly 65 seconds. A session may place only one robot order per hour; the API enforces the cooldown even when multiple tabs or checkout requests race. Live robot pickup availability and ETAs are placeholders for a later integration.

### Shared login, checkout identity, and multiple tabs

Every tab on the same origin sends the `campus_demo_session` HttpOnly cookie, so tabs share one server session, CSRF token, wallet, order history, and checkout ownership. Checkout attempts use UUID idempotency keys and are stored in `checkout_queue`; a unique SQL partial index allows only one pending or held reservation per session. The server remains authoritative if a tab is duplicated, refreshed, or sends concurrent requests.

Name and student identity are intentionally not collected by this demo. School SSO can provide the identity later; the resulting SSO subject should be mapped to an internal user record before attaching it to an order.

`BroadcastChannel` with a `localStorage` fallback synchronizes cart, checkout, session, and order events between tabs. The receiving tab reloads authoritative server state instead of trusting the broadcast payload, so the UI updates quickly without weakening the database guarantees.

The UI follows Material 3 tokens and includes a small self-contained Material Web-compatible layer at `src/lib/materialWebFallback.ts` for assist chips and outlined controls. It keeps the app bundle self-contained until the official `@material/web` dependency can be installed.

## Shared stock and checkout ticks

The server initializes 20 demo units of each product once. Inventory is shared by all visitors; refreshing, opening a new session, or restarting does not replenish it. Orders made before inventory was introduced remain in order history and wallet totals, but do not consume the new initial stock. There is no automatic restock or public stock-editing endpoint.

Checkout requests enter a durable database queue and wait for their server-assigned 100 ms tick to close. The database assigns an increasing sequence number: the first valid checkout recorded wins, including ties within one tick. Browser click times, client timestamps, and request IDs never determine priority. Network latency can affect when a request reaches the queue; this is first-come-first-served, not a lottery.

Each settlement transaction processes up to eight queued checkouts in sequence. Entering checkout now requests a reservation: after its tick succeeds, the entire cart is held for five minutes and unavailable to other visitors. Confirmation converts the hold into an order and stock allocation atomically. The wallet is charged only at confirmation. Insufficient stock or funds rejects the whole cart. Duplicate retries return the same outcome. Database transactions and a queue-head guard coordinate multiple Workers, so in-memory locks are not required.

The request waits briefly for its tick, then settles eligible work. A pending response uses HTTP 202; the browser polls the session-protected `/api/checkouts/:requestKey` route and retains its retry ID across interruptions. This is request-driven tick processing, not a continuously running game loop: after a disconnect, later checkouts/status polls resume any durable pending work. Under load, confirmation can take longer than 100 ms.

### Five-minute reservations and offline inventory

`POST /api/reservations` uses the same FIFO tick queue. The deadline is set once when the server records the request and cannot be extended by refreshing, retries, status polls, or going offline. At most one active reservation is allowed per demo session. Confirmation and cancellation use session-owned, CSRF-protected endpoints. The prior `/api/orders` checkout remains compatible with old clients but checks inventory after subtracting active holds.

Availability queries exclude a hold at its exact expiry timestamp, so inventory is released even if the browser is closed and no background cleanup runs. Expired queue rows remain as retry/audit records; their quantities no longer count against stock. The browser clears every unconfirmed checkout item at expiry, including while offline, or immediately upon waking/reopening a suspended tab. Cancelling early releases the hold and keeps the bag for editing. Completed orders never expire. If a confirmation response is lost, its identifier is preserved until the server can resolve whether a purchase succeeded; a local timeout never assumes a purchase failed.

The last successful catalog response and its server inventory timestamp are saved in localStorage and restored for offline browsing. The UI separately records the last successful API contact. Inventory refreshes every 15 minutes while online and checks whether a refresh is due after reconnecting or waking the tab. Failed requests do not replace the snapshot or advance its timestamps. Checkout changes and the manual Reconnect button refresh inventory immediately; active orders and checkout status may poll every five seconds without refreshing catalog data. Cached stock is illustrative and never authorizes a reservation or purchase. With no saved snapshot, the app shows the sample menu and says inventory has not been fetched. Offline checkout is disabled; payment requests are never replayed automatically. Initial online loading is required to cache the app shell, and browser storage must be available to retain snapshots across reloads.

Run `node --test tests/inventory.test.mjs` to exercise twelve buyers competing for the last unit, tick boundaries, FIFO priority, stock/fund rejection, retries, separate database connections, and transaction rollback. To reproduce a one-unit scenario locally, use an isolated test database as these tests do rather than changing the public demo's shared stock.

## Refactoring completed

The main React component now composes separate UI components. Store state and PWA behavior have separate hooks, with shared helpers for requests, storage, and currency formatting. Server routing, checkout logic, and HTTP utilities are also separated. Existing behavior is preserved and the code has been formatted for readability.

## Validation

```powershell
npm run lint
npm run build
npm test
```

The suite covers inventory competition, five-minute holds and expiry, confirmation/cancellation, offline snapshot restoration, refresh timing, atomic checkout, price validation, duplicate retries, concurrent overspending, ownership, CSRF, invalid carts, simulated delivery states, rejection of unsupported live mode, icons, and service-worker caching/update behavior.

These checks are not a full penetration test or approval to process real school payments.

## Remaining work before launch

- Connect school sign-in, catalog, and wallet APIs through server-side adapters after the school provides their API specifications and an authorized test environment.
- Connect the robot provider through the backend with delivery confirmation, failure handling, and payment reconciliation.
- Keep integration secrets on the server; never put them in frontend code or `VITE_` variables.
- The demo is hosted on Sites with an HTTPS address and a D1 database. Real integrations still require their own deployment review and operational controls.
- Test real integration failures, permissions, refunds, and delivery handling in the authorized sandbox before launch.

`INTEGRATION_MODE` defaults to `demo`; unsupported modes reject API requests. Setting it to `live` does not enable real integrations. Environment options are documented in `.env.example`; the current scripts read process environment variables and do not automatically load that file.
