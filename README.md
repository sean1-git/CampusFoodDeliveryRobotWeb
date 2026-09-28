# UC Merced Campus Store

A shopping PWA for UC Merced. Students order from The Summit's Marketplace and Bobcat's Snack Shop, then choose a campus meeting point for a simulated robot delivery.

[Try the demo](https://projectdemo-qf2f7jkpma-ew.a.run.app/)

The demo uses sample inventory and a $50 wallet. School sign-in, real payments, and physical robots are not connected.

## Stack

| Layer | Tools | Why |
| --- | --- | --- |
| Frontend | React, TypeScript, Vite, Material Web | Reusable components, typed checkout state, and code splitting. |
| Backend | Node.js HTTP API, SQLite, Drizzle migrations | Transactional checkout without a separate database service. Node's built-in SQLite driver runs queries; Drizzle versions the schema. |
| Maps | Google Maps JavaScript API, OpenStreetMap | Google displays the map; campus walkway data defines delivery paths. |
| Deployment and mobile | Docker, Cloud Run, Capacitor | Repeatable deployments and a shared React UI for web and native projects. Native releases still need testing and signing. |

## Engineering choices

- **PWA:** cached UI assets reduce repeat downloads and help returning visits load faster. The bag and latest catalog remain available offline; checkout needs a connection.
- **Performance:** maps and order history load on demand. Build-time Brotli/gzip compression reduces transfers; reused cart and map calculations reduce browser work.
- **Checkout:** a database FIFO queue, five-minute stock holds, transactions, and idempotency keys protect against overselling and duplicate charges. CSRF and ownership checks protect account actions.
- **Routing:** Dijkstra finds the shortest mapped walkway route and compares both store pickup orders. Saved routes keep deliveries consistent after map updates; live obstacles are not modeled.

## Scaling options

Currently, one Cloud Run instance uses local SQLite; container replacement resets its data. Proposed next steps:

1. **Shared database:** migrate to [Cloud SQL for PostgreSQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run) with connection pooling. Adapt SQLite transactions and triggers, then load-test checkout before running multiple API instances.
2. **Background jobs:** use [Cloud Tasks](https://docs.cloud.google.com/run/docs/triggering/using-tasks) for inventory sync and future robot dispatch, with idempotent retries and database-controlled stock allocation.
3. **Less server traffic:** add a CDN for static assets and event-driven delivery updates. Keep account responses private and validate stock at checkout. Measure latency, contention, and errors before increasing capacity.

## Run and check

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

Tests cover checkout races, retries, security, routes, and offline recovery. After building, stop the dev server and run `npm start` at [localhost:8787](http://localhost:8787) to test the production PWA.

[Walkway data and attribution](docs/WALKWAY_DATA.md) · [Native setup](NATIVE.md) · [Dependency maintenance](docs/DEPENDENCIES.md)
