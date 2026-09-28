# Dependency maintenance

The web UI and native apps need the packages in `package.json` during their builds. The Cloud Run Node API imports only built-in modules and local files, so its runtime image contains no `node_modules`. `build:web` produces the web assets; `build` also keeps the alternate Worker bundle available. Drizzle is used to generate migration SQL, not to run API queries.

Two development-tool overrides patch transitive dependencies without changing the main frameworks:

| Parent | Override | Reason |
| --- | --- | --- |
| `@esbuild-kit/core-utils@3.3.2` | `esbuild@0.25.12` | [esbuild advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99) |
| `xcode@3.0.1` | `uuid@11.1.1` | [UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq); retains the CommonJS `v4()` API used by xcode |

Overrides apply only to these parent versions. Remove them when upstream packages ship compatible fixes. Run `npm ci`, `npm audit`, `npm run build`, `npm test`, and `npm run native:sync` when updating them. The tests exercise the TypeScript transforms, in-memory Xcode project edits, and the Node runtime without installed packages. Native sync still does not replace Android/iOS device builds and testing.
