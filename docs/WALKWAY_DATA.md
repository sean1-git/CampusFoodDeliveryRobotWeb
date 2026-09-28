# UC Merced walkway snapshot

`shared/campusWalkways.json` is a derived OpenStreetMap pedestrian graph for the campus delivery **simulation**. It replaces manually drawn route geometry with mapped walkway connectivity. It is not a surveyed robot navigation map and does not certify path width, slope, pavement, temporary closures, crossing safety, or permission to operate a robot.

## Source and scope

- Source: [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), downloaded September 27, 2026.
- Campus boundary: closed [university way 170555864](https://www.openstreetmap.org/way/170555864).
- Extract: [OSM map API](https://api.openstreetmap.org/api/0.6/map?bbox=-120.433,37.358,-120.412,37.372). The extract covers the full boundary, not just the former delivery loop.
- Data is licensed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Retain **© OpenStreetMap contributors** with a link to the copyright page in the map UI and comply with the attribution and share-alike requirements when distributing this derived database.
- The source XML stays in ignored `.sites-runtime/`; contributor names, user IDs, changesets, and unrelated features are not included in the committed dataset. The metadata records its SHA-256 so an archived input can be verified.

The extract may omit unmapped paths. This static snapshot does not poll OSM or reflect real-time closures.

## Reproduce the snapshot

Save the public XML response in `.sites-runtime/ucm-osm-full-campus.xml`, then run from the repository root:

```sh
node scripts/import-campus-walkways.mjs .sites-runtime/ucm-osm-full-campus.xml shared/campusWalkways.json 2026-09-27
node --test tests/walkway-import.test.mjs
```

The importer is offline, uses no additional dependencies, and produces identical output for identical input and snapshot date. A fresh download is a new snapshot, because OpenStreetMap data changes. Review graph changes and bump the data version before releasing a changed network. Regenerating this file does not modify saved orders or their frozen routes.

## Inclusion rules

- Include `highway=footway`, `path`, and `pedestrian` line features. Include `cycleway`, `service`, and `living_street` only when `foot=yes/designated/permissive/official` explicitly allows walking.
- Apply mode-specific pedestrian access: explicit public `foot` permission overrides a generic `access=private/no` tag that restricts vehicles. This is necessary for mapped Scholars Lane and Academic Walk. `foot=no/private` and other restricted pedestrian access remain excluded.
- Exclude stairs, indoor ways, construction/proposed paths, conditional access, wheelchair-prohibited ways, and `area=yes` polygons. Ordinary vehicle roads are not inferred to have sidewalks.
- Break a path at locked or unverified barrier nodes. Lowered/flush curbs are retained. Other barriers require both explicit public foot access and `wheelchair=yes`; foot access by itself does not establish clearance.
- Keep only entire segments within the actual university polygon. A concave-boundary check prevents an edge with inside endpoints from leaving campus in between. Boundary intersections do not create new graph connections.
- Preserve original OSM node IDs and way identity. Shared source nodes create junctions; a visual crossing or nearby endpoint does not. No nearest-node bridges, gap-filling lines, or connections between separate components are invented.

Access tags and OSM connectivity are evidence for this simulation, not a claim of real robot passability. Store anchors were supplied by the project owner; their short access legs remain explicit simulation estimates.

## Connectivity and pickup anchors

The snapshot has **1,056 nodes, 1,190 edges, and 319 path runs**, divided into 14 connected components. The largest component contains **885 nodes, 1,032 edges, and 290 path runs**. Both store anchors are adjacent to that component:

| Store anchor | Nearest mapped walkway point | Offset |
| --- | --- | --- |
| Summit: `37.363352, -120.429973` | Scholars Lane: `37.3633223493, -120.4299731449` | 3.30 m |
| Bobcat: `37.366145, -120.424243` | Bobcat Walk: `37.3661095368, -120.4242011621` | 5.41 m |

Use the component reachable from both pickups for customer pins. Preserve disconnected source components in this data for review, but do not offer them for delivery or bridge their gaps. Remaining component node counts: `87, 36, 10, 9, 9, 6, 2, 2, 2, 2, 2, 2, 2`.

## Format

- `metadata`: version, source and attribution links, license, source SHA-256, snapshot date, source extract bounds, actual university bounds, counts, excluded-segment counts, and limitations.
- `boundary`: closed `[latitude, longitude]` ring from the university way.
- `nodes`: `{ id, lat, lng }`, where `id` preserves the OSM node ID with an `osm-node-` prefix.
- `edges`: undirected `[nodeIndexA, nodeIndexB]` pairs, with duplicates removed.
- `paths`: `{ id, osmWayId, name, nodes }`. A way can become several runs after campus clipping or barrier exclusions. The original way ID remains available; unknown names appear as “Campus walkway.”

The app snaps a selection within 25 meters onto its nearest eligible walkway. The server independently validates campus membership and an 8-meter maximum input offset, then stores the projected meeting point. Shortest-path routing uses shared nodes rather than geometric crossings and only offers the component reachable from both shops. Dijkstra predecessor trees are cached per pickup; map geometry loads with the map screen.

Submitted confirmation coordinates are retained in the request fingerprint so a map update cannot invalidate an existing checkout retry. Store pickups, loading pauses, route geometry, and arrival estimates remain frozen with each saved order. Existing orders are replayed without loading or recalculating the current graph.
