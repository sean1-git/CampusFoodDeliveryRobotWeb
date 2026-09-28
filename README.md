# UC Merced Campus Store

A shopping PWA for UC Merced. Students shop at The Summit's Marketplace and Bobcat's Snack Shop, choose a campus meeting point, and follow a simulated robot delivery.

I built this so students wouldn't have to walk across campus just to find out whether a store has what they need. The idea is to check availability with a tap, buy an item, and have it delivered to their campus meeting point.

[Try the demo](https://projectdemo-qf2f7jkpma-ew.a.run.app/) 

The demo uses sample inventory and a $50 wallet. School sign-in, real payments, and physical robots are not connected.

## How it works

1. **Fill your bag.** Search or filter either shop and combine items from both stores. Adding items does not reserve stock.
2. **Choose a meeting point.** Select a campus walkway or use your location, then confirm the pin. Location sharing is optional.
3. **Reserve and confirm.** Stock is held for five minutes. Confirmation charges the demo wallet; cancellation or expiry releases stock.
4. **Follow the delivery.** Watch the simulated robot visit the shops and your pin. Mixed-store orders compare both pickup sequences. Another order unlocks at arrival.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite, Material Web |
| Backend | Node.js HTTP API, cookie sessions, CSRF protection |
| Database | SQLite through Node's built-in driver; Drizzle schema and SQL migrations |
| Maps and routing | Google Maps JavaScript API, OpenStreetMap walkway graph, Dijkstra |
| Infrastructure | Docker, Cloud Run; Cloud Build deploys, GitHub Actions reports deployment status |
| Mobile | PWA service worker and manifest; Capacitor Android/iOS development projects |

## Why these choices

- **PWA:** cached assets reduce repeat downloads and help returning visits load faster. The bag and latest catalog remain available offline; checkout needs a connection.
- **React and TypeScript:** reusable components and typed state keep the UI maintainable. Lazy-loaded maps, Brotli/gzip compression, and reused calculations reduce loading and browser work.
- **SQLite:** simple demo setup with transactional stock updates. FIFO checkout and idempotency keys protect against overselling and duplicate charges.
- **Docker:** packages the API, built frontend, shop photos, and icons into one consistent Cloud Run release. A [multi-stage build](https://docs.docker.com/build/building/multi-stage/) keeps build tools and original artwork out of the runtime image.

## Project structure

```text
src/             # React UI, hooks, client helpers, and PWA registration
server/          # HTTP API, sessions, inventory, and checkout
shared/          # Catalog, stores, walkway data, and routing
db/, drizzle/    # Drizzle schema and SQL migrations
public/, assets/ # Served assets and source artwork
android/, ios/   # Capacitor native projects
scripts/         # Development, builds, compression, and walkway import
tests/           # API, checkout, routing, offline, and tooling checks
docs/            # Walkway data and dependency notes
```

## Local development

Use Node.js 22.19+ or 24:

```sh
npm ci
npm run dev
```

The UI normally runs at [localhost:5173](http://localhost:5173). Configure a referrer-restricted `GOOGLE_MAPS_BROWSER_KEY` using [.env.example](.env.example). The Node server does not load `.env` automatically. Keep secrets out of Git and `VITE_*` variables.

```sh
npm run lint
npm run build
npm test
```

Tests cover checkout races, retries, security, routes, and offline recovery. To test the production PWA, build it, stop the dev server, run `npm start`, then open [localhost:8787](http://localhost:8787).

## Scaling options

The demo runs one Cloud Run instance with local SQLite; container replacement resets its data. Proposed next steps:

1. **Shared database:** move to [Cloud SQL for PostgreSQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run) with connection pooling. Adapt SQLite transactions and triggers, then load-test checkout before adding API instances.
2. **Background jobs:** use [Cloud Tasks](https://docs.cloud.google.com/run/docs/triggering/using-tasks) for inventory sync and future robot dispatch, with idempotent retries and database-controlled stock allocation.
3. **Less server traffic:** add a CDN and event-driven delivery updates. Store future uploads and frequently changing product photos in object storage. Keep account responses private and verify stock at checkout; measure latency and contention before increasing capacity.

## Documentation

- [Configuration](.env.example): environment variables and key restrictions.
- [Walkway data](docs/WALKWAY_DATA.md): coverage, routing limits, import steps, and attribution.
- [Native setup](NATIVE.md): Android/iOS development, testing, and signing requirements.
- [Dependencies](docs/DEPENDENCIES.md): runtime packaging and tooling maintenance.
- [Deployment](docs/DEPLOYMENT.md): Cloud Run releases and GitHub deployment reporting.
