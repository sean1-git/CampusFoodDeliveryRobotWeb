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

## Refactoring completed

The main React component now composes separate UI components. Store state and PWA behavior have separate hooks, with shared helpers for requests, storage, and currency formatting. Server routing, checkout logic, and HTTP utilities are also separated. Existing behavior is preserved and the code has been formatted for readability.

## Validation

```powershell
npm run lint
npm run build
npm test
```

All checks passed after refactoring, including 12 tests covering price validation, duplicate checkout retries, concurrent overspending, order ownership, CSRF checks, invalid carts, simulated delivery states, rejection of unsupported live mode, icons, and service-worker caching/update behavior. A browser check also confirmed that the cached storefront loads with the test server stopped.

These checks are not a full penetration test or approval to process real school payments.

## Remaining work before launch

- Connect school sign-in, catalog, and wallet APIs through server-side adapters after the school provides their API specifications and an authorized test environment.
- Connect the robot provider through the backend with delivery confirmation, failure handling, and payment reconciliation.
- Keep integration secrets on the server; never put them in frontend code or `VITE_` variables.
- Deploy the client and API to an HTTPS host with a configured database and migration process. A worker bundle is built, but hosting has not been deployed or verified. The Sites hosting plugin became unavailable during setup.
- Test real integration failures, permissions, refunds, and delivery handling in the authorized sandbox before launch.

`INTEGRATION_MODE` defaults to `demo`; unsupported modes reject API requests. Setting it to `live` does not enable real integrations. Environment options are documented in `.env.example`; the current scripts read process environment variables and do not automatically load that file.
