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

Demo order data is stored locally in `.data/campus-demo.sqlite`. Demo sessions use cookies; there is no school login. Cart contents are stored in the browser. Each session starts with $50 in simulated funds. A demo delivery costs $1, and order progress is simulated over roughly 65 seconds.

## Shared stock and checkout ticks

The server initializes 20 demo units of each product once. Inventory is shared by all visitors; refreshing, opening a new session, or restarting does not replenish it. Orders made before inventory was introduced remain in order history and wallet totals, but do not consume the new initial stock. There is no automatic restock or public stock-editing endpoint.

Checkout requests enter a durable database queue and wait for their server-assigned 100 ms tick to close. The database assigns an increasing sequence number: the first valid checkout recorded wins, including ties within one tick. Browser click times, client timestamps, and request IDs never determine priority. Network latency can affect when a request reaches the queue; this is first-come-first-served, not a lottery.

Each settlement transaction processes up to eight queued checkouts in sequence. It checks the entire cart and wallet, records the order and stock allocation, and stores the outcome atomically. Insufficient stock or funds rejects the whole cart without charging or reserving anything. Duplicate retries return the same outcome. Database transactions and a queue-head guard coordinate multiple Workers, so in-memory locks are not required.

The request waits briefly for its tick, then settles eligible work. A pending response uses HTTP 202; the browser polls the session-protected `/api/checkouts/:requestKey` route and retains its retry ID across interruptions. This is request-driven tick processing, not a continuously running game loop: after a disconnect, later checkouts/status polls resume any durable pending work. Under load, confirmation can take longer than 100 ms. Storefront counts refresh every five seconds; the server's checkout decision remains authoritative.

Run `node --test tests/inventory.test.mjs` to exercise twelve buyers competing for the last unit, tick boundaries, FIFO priority, stock/fund rejection, retries, separate database connections, and transaction rollback. To reproduce a one-unit scenario locally, use an isolated test database as these tests do rather than changing the public demo's shared stock.

## Refactoring completed

The main React component now composes separate UI components. Store state and PWA behavior have separate hooks, with shared helpers for requests, storage, and currency formatting. Server routing, checkout logic, and HTTP utilities are also separated. Existing behavior is preserved and the code has been formatted for readability.

## Validation

```powershell
npm run lint
npm run build
npm test
```

The suite includes 20 tests covering inventory competition and atomic checkout, price validation, duplicate retries, concurrent overspending, order ownership, CSRF checks, invalid carts, simulated delivery states, rejection of unsupported live mode, icons, and service-worker caching/update behavior.

These checks are not a full penetration test or approval to process real school payments.

## Remaining work before launch

- Connect school sign-in, catalog, and wallet APIs through server-side adapters after the school provides their API specifications and an authorized test environment.
- Connect the robot provider through the backend with delivery confirmation, failure handling, and payment reconciliation.
- Keep integration secrets on the server; never put them in frontend code or `VITE_` variables.
- The demo is hosted on Sites with an HTTPS address and a D1 database. Real integrations still require their own deployment review and operational controls.
- Test real integration failures, permissions, refunds, and delivery handling in the authorized sandbox before launch.

`INTEGRATION_MODE` defaults to `demo`; unsupported modes reject API requests. Setting it to `live` does not enable real integrations. Environment options are documented in `.env.example`; the current scripts read process environment variables and do not automatically load that file.
