# CampusFoodDeliveryRobotWeb — Campus Store PWA

Food delivery prototype for campus shopping and robot delivery.

Hosted Site: [UCM Campus Store](https://ucm-campus-store.seanlee5697.chatgpt.site).

A React + TypeScript campus-store prototype with a Node/SQLite demo API. All products, funds, and robot delivery statuses are simulated. It does not connect to the school or dispatch robots.

No school login is required for the demo. Opening the store creates an anonymous browser session with a $50 simulated wallet. Visitors can reserve items, confirm demo purchases, and follow the robot simulation. Real payments and physical robot dispatch remain disabled.

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

This is suitable for a temporary demo only. The SQLite file is inside the container, so accounts, cooldowns, and orders disappear if Cloud Run replaces the instance. Production requires a durable shared database for all API instances; independent SQLite files cannot enforce cross-instance account cooldowns. Port and verify the transaction/trigger guarantees when moving to Cloud SQL or another managed database.

### HTTPS deployment proxies

Configure the Node process/service environment before starting it. The preferred production setting is `CANONICAL_ORIGIN=https://your-actual-public-host` (replace the example with your real public origin). This forces absolute request URLs and same-origin POST checks to use that HTTPS origin even when the proxy-to-Node connection is HTTP or its Host header names an internal service. It takes precedence over Host and forwarded headers. Paths/query strings remain unchanged. Only an origin is accepted, with no credentials, path prefix, query, or fragment; production requires HTTPS. Invalid settings stop Node startup.

If a canonical origin is not configured, the Node adapter uses the connection protocol and Host header. To respect a proxy's `X-Forwarded-Proto`, explicitly set one of:

- `TRUST_PROXY=loopback` for a reverse proxy on the same machine.
- `TRUST_PROXY=10.0.0.5,10.0.0.6` for specific immediate proxy IP addresses (IPv4/IPv6, not CIDR ranges). Trust is checked against the socket peer, never `X-Forwarded-For`.
- `TRUST_PROXY=true` only when Node is reachable **exclusively through trusted ingress** that overwrites `X-Forwarded-Proto`. Do not enable this for a publicly reachable, unprotected Node port.

Proxy trust defaults to `false`, so clients cannot select HTTPS merely by supplying a forwarded header. A trusted header must be one `http` or `https` value; ambiguous comma-separated hop lists or invalid protocols return HTTP 400. Configure the final proxy to overwrite the header with the verified external protocol, rather than append to client-provided values. `X-Forwarded-Host` and the standardized `Forwarded` header are not consumed; preserve the external Host or configure the canonical origin instead. Using a canonical origin requires no forwarded-header trust.

Additional frontend origins can be listed explicitly in `ALLOWED_ORIGINS`. Production no longer automatically allows the Vite localhost origins. Canonical-origin configuration replaces the internal request origin for POST validation; it does not add the internal HTTP origin to the allowlist. Student authentication, CSRF-token checks, and cross-site request rejection still apply. `.env.example` documents these settings, but the scripts do not automatically load it; set actual deployment environment variables. These changes configure application behavior, not proxy infrastructure or a live cloud deployment.

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
| `server/api.mjs` | API routes and authenticated account access |
| `server/auth.mjs` | Anonymous demo session issuance and an optional future verified SSO adapter |
| `server/orders.mjs` | Validates checkout, calculates prices, and creates demo orders |
| `server/http.mjs` | JSON responses, request limits, and response headers |
| `server/local.mjs` | Local HTTP server |
| `server/worker.mjs` | Worker deployment entry point |
| `db/schema.ts` and `drizzle/` | Database schema and generated migration |
| `scripts/build-pwa.mjs` | Generates the production service worker |
| `tests/` | API and PWA checks |

Accounts, sessions, cooldowns, and demo orders are stored locally in `.data/campus-demo.sqlite`. Cart contents are stored in the browser. Each demo account starts with $50 in simulated funds. A demo delivery costs $1. Orders prepare for 20 seconds and then follow the selected campus route's simulated travel time. A demo account may place only one robot order per hour. Live robot pickup availability and real-world ETAs still require a robot integration.

### Shared login, checkout identity, and multiple tabs

Every tab on the same origin sends the `campus_demo_session` HttpOnly, SameSite=Lax cookie (Secure on HTTPS and all production deployments). It contains only a random session ID, not a cooldown, balance, or student identity. `GET /api/session` creates a demo account and session atomically when no valid cookie exists; checkout endpoints never create sessions. Wallet totals, order history, checkout ownership, and UUID idempotency keys are account-scoped. A unique SQL partial index permits only one pending or held checkout per account across both reservation and direct-purchase endpoints.

The anonymous demo wallet is shared by tabs using the same browser cookie, not across browsers or devices. Deleting cookies, using a private window, or waiting for the seven-day session expiry starts a new $50 wallet. The one-order-per-hour limit applies to that demo account, not a verified student identity. The existing stock checks, five-minute reservation expiry, CSRF checks, ownership validation and retry protection still apply.

The authoritative deadline is `accounts.cooldown_until`. Checkout transactions check the account deadline, funds, and stock; SQL triggers also reject orders during cooldown and advance the deadline by one hour on successful insertion. Order creation, inventory allocation, queue settlement, and cooldown advancement commit or roll back together. Duplicate retries return the original order without charging twice or extending the deadline. Failed or cancelled checkouts do not start a cooldown.

Migration `0005_student_accounts.sql` preserves old anonymous orders under non-authenticated legacy accounts; it never assigns that history to a real student. It cancels surplus active legacy checkout rows to install the account-wide uniqueness constraint while retaining audit records. Local startup applies SQL migrations automatically. Other deployment targets must apply the SQL migrations, including the custom triggers, before running the new API.

Name and student ID are not collected in the browser. Migration `0007_anonymous_demo_checkout.sql` permits server-issued anonymous accounts in the existing anonymous/legacy database category, distinguished by the reserved `campus-demo-v1` issuer; old legacy cookies remain invalid. Demo users are never marked as verified students. Requests cannot supply account or student identities. Missing/expired checkout cookies return HTTP 401 until the browser reconnects through `/api/session`. Unsupported live mode rejects requests before any demo session creation.

The unused `issueStudentSession` helper remains available for future real school sign-in. A future adapter must verify the school's assertion/token, trusted issuer, audience, expiry, state/nonce, and student eligibility before calling it. It does not verify tokens itself and is not exposed as a public endpoint.

`BroadcastChannel` with a `localStorage` fallback synchronizes cart, checkout, session, and order events between tabs. The receiving tab reloads authoritative server state instead of trusting the broadcast payload, so the UI updates quickly without weakening the database guarantees.

Completed orders invalidate other tabs' wallet, order history, and cooldown immediately. Detected session replacement also triggers a peer refresh; HTTP 401 clears the displayed wallet and history. Events have unique IDs to deduplicate delivery across both transports; receiving a cart or reservation snapshot does not echo it back. Account reads are serialized and repeated if an event arrives during an older request. Focus, page restoration, and visibility changes refresh account state, with a 30-second fallback poll for idle tabs (five seconds during active orders/checkouts). Broadcast events are limited to the same browser/origin; other browsers/devices refresh from the shared account API on focus or polling. Real school SSO is still pending, so cross-browser identities are currently exercised by server-side tests, not a working login screen.

The UI follows Material 3 tokens and includes a small self-contained Material Web-compatible layer at `src/lib/materialWebFallback.ts` for assist chips and outlined controls. It keeps the app bundle self-contained until the official `@material/web` dependency can be installed.

## Shared stock and checkout ticks

The server initializes 20 demo units of each product once. Inventory is shared by all visitors; refreshing, opening a new session, or restarting does not replenish it. Orders made before inventory was introduced remain in order history and wallet totals, but do not consume the new initial stock. There is no automatic restock or public stock-editing endpoint.

Checkout requests enter a durable database queue and wait for their server-assigned 100 ms tick to close. The database assigns an increasing sequence number: the first valid checkout recorded wins, including ties within one tick. Browser click times, client timestamps, and request IDs never determine priority. Network latency can affect when a request reaches the queue; this is first-come-first-served, not a lottery.

Each settlement transaction processes up to eight queued checkouts in sequence. Entering checkout now requests a reservation: after its tick succeeds, the entire cart is held for five minutes and unavailable to other visitors. Confirmation converts the hold into an order and stock allocation atomically. The wallet is charged only at confirmation. Insufficient stock or funds rejects the whole cart. Duplicate retries return the same outcome. Database transactions and a queue-head guard coordinate multiple Workers, so in-memory locks are not required.

The request waits briefly for its tick, then settles eligible work. A pending response uses HTTP 202; the browser polls the session-protected `/api/checkouts/:requestKey` route and retains its retry ID across interruptions. This is request-driven tick processing, not a continuously running game loop: after a disconnect, later checkouts/status polls resume any durable pending work. Under load, confirmation can take longer than 100 ms.

### Five-minute reservations and offline inventory

`POST /api/reservations` uses the same FIFO tick queue. The deadline is set once when the server records the request and cannot be extended by refreshing, retries, status polls, or going offline. At most one active checkout is allowed per student account. Confirmation and cancellation use account-owned, CSRF-protected endpoints. The prior `/api/orders` checkout also requires authentication and cannot bypass an account's existing reservation.

Availability queries exclude a hold at its exact expiry timestamp, so inventory is released even if the browser is closed and no background cleanup runs. Expired queue rows remain as retry/audit records; their quantities no longer count against stock. The browser clears every unconfirmed checkout item at expiry, including while offline, or immediately upon waking/reopening a suspended tab. Cancelling early releases the hold and keeps the bag for editing. Completed orders never expire. If a confirmation response is lost, its identifier is preserved until the server can resolve whether a purchase succeeded; a local timeout never assumes a purchase failed.

The last successful catalog response and its per-item source metadata are saved in localStorage and restored for offline browsing. The UI separately records the browser's catalog fetch time and last successful API contact; neither represents a stock change. Catalog refreshes every 15 minutes while online and checks whether a refresh is due after reconnecting or waking the tab. Failed requests do not replace the snapshot or advance its timestamps. Checkout changes and the manual Reconnect button refresh inventory immediately; active orders and checkout status may poll every five seconds without refreshing catalog data. Cached stock is illustrative and never authorizes a reservation or purchase. With no saved snapshot, the app shows the sample menu and says the catalog has not been fetched. Offline checkout is disabled; payment requests are never replayed automatically. Initial online loading is required to cache the app shell, and browser storage must be available to retain snapshots across reloads.

### Inventory freshness contract

- Each product in `GET /api/catalog` exposes `stockUpdatedAt`: the POS/inventory system's reported stock-change timestamp, or `null` when unavailable. It is never inferred from receipt time, local quantity differences, orders, or reservation expiry.
- Each product also exposes `syncedAt`: when this backend received the successfully accepted source data, or `null` if no source synchronization has occurred. Repeated catalog reads do not advance it. When the upstream system provides no change timestamp, the UI shows **Last synced with inventory source**, explicitly stating that the stock-change time is unavailable.
- The top-level `responseGeneratedAt` means only when the API generated this catalog response. It replaces the misleading `inventoryUpdatedAt` field. Browser-cache `fetchedAt` separately tracks when the browser successfully fetched the catalog, for refresh scheduling.
- All timestamps are Unix epoch milliseconds. Fields are per-item because sources can update products independently; no single catalog timestamp claims every product changed or synced together. Existing v1 browser snapshots retain stock, but discard the old ambiguous timestamp and leave source freshness unknown.
- Migration `0006_inventory_freshness.sql` adds nullable `stock_updated_at` and `synced_at` columns without fabricating historical values. Demo seeding leaves both null because **no POS/inventory integration is connected yet**.
- The future trusted source adapter can include `inventoryFreshnessStatement` in the same database batch as successfully reconciled stock. Capture the receipt time on the backend and pass the source change time only when supplied; an unchanged source snapshot can advance `syncedAt` without changing `stockUpdatedAt`. Failed transactions roll both back. The helper only writes metadata, is not a public API, and does not implement POS quantity reconciliation, upstream version ordering, or duplicate-event handling. Those must be implemented with the real source contract before live sync is enabled; incoming on-hand stock cannot simply replace this demo's allocation baseline.

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

`tests/account-cooldown.test.mjs` additionally verifies multiple sessions for one student, new cookies, cross-account isolation, concurrent requests, persistent cooldowns across restarts/connections, spoofed client identity/time, exact deadline boundaries, transaction rollback, and legacy migration preservation.

These checks are not a full penetration test or approval to process real school payments.

## Google Maps delivery simulation

- Checkout requires an explicitly confirmed latitude/longitude pin. The server rejects missing, unconfirmed, malformed, off-campus or off-corridor destinations before reserving stock or charging. Five-minute reservations freeze the confirmed pin; cancel to edit. Migration 0008 cancels old unfinished checkouts without pins, preserving completed orders.
- Google Maps JavaScript API displays the map and draggable delivery marker. Set GOOGLE_MAPS_BROWSER_KEY at runtime: /api/maps-config intentionally exposes this public browser key. Restrict it at Google to the Maps JavaScript API and the exact Cloud Run referrers. Do not substitute an unrestricted/server key. Maps loads only when the map is opened; usage belongs to the configured Google billing project. The API key is not committed.
- Use my location asks for browser permission and reads one fresh fix with a 12-second timeout. No continuous tracking. Raw accuracy/location remain in component memory; only the explicitly confirmed destination is saved in the checkout and account-owned order. Declining permission leaves manual selection available. Wi-Fi alone does not establish an exact student position.
- Product storeId values in shared/catalog.json assign sandwich, salad and coffee to the Kolligian Library store; noodles, lemonade and cookie to The Summits Marketplace. These are sample assignments, not actual store inventory. The server ignores client-supplied store IDs, prices and route estimates.
- shared/campusGeo.ts uses the three supplied coordinates as demo anchors and a conservative service envelope with 8-meter-wide acceptance on each side of its two connecting segments. These segments are **provisional simulation geometry, not mapped sidewalk paths**. Library and marketplace pickup positions are nearby demo anchors, not surveyed entrances. They may cross buildings or other inaccessible areas: never use them to command a physical robot. Replace them with verified path geometry and store entrances before operational navigation.
- Dijkstra computes travel legs at 1 m/s. The simulated robot starts at a pickup store; mixed-store bags compare both pickup sequences and visit both before delivery. Preparation is 20 seconds; pickup dwell times, traffic, obstacles and live telemetry are not modeled. Route geometry, pickup sequence and duration are persisted with the order, so reloads and polling preserve the same ETA. Movement offline is only a prediction; Google map tiles are not cached by this PWA.
- The old image map and shared/campusRouting.ts remain only to display legacy orders. Google Maps is the current location picker. No Google Geolocation API, AI model or real robot dispatch is used.
- Tests in tests/geolocation.test.mjs cover geofencing, exact pin preservation, store assignments, mixed-store route choice, ETA, missing-pin wallet protection, forged routes, retries and changed-pin conflicts. The rest of the checkout/security suite remains active.

## Remaining work before launch

- School SSO is deferred: the current demo explicitly supports anonymous purchases. Select an identity provider only when resuming real school integration.
- Connect school sign-in, catalog, and wallet APIs through server-side adapters after the school provides their API specifications and an authorized test environment.
- Connect the robot provider through the backend with delivery confirmation, failure handling, and payment reconciliation.
- Keep integration secrets on the server; never put them in frontend code or `VITE_` variables.
- Review hosting, durable database migrations, backups, and operational controls before enabling real integrations. A deployment configuration is not proof that a deployment is live.
- Test real integration failures, permissions, refunds, and delivery handling in the authorized sandbox before launch.

`INTEGRATION_MODE` defaults to `demo`; unsupported modes reject API requests. Setting it to `live` does not enable real integrations. Environment options are documented in `.env.example`; the current scripts read process environment variables and do not automatically load that file.
