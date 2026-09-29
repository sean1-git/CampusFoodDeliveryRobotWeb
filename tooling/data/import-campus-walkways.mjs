import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { importWalkways } from "./lib/walkway-import.mjs";

// No network access: an explicitly saved OSM XML snapshot is the only input.
const [input = ".sites-runtime/ucm-osm-full-campus.xml", output = "packages/domain/src/campus/campusWalkways.json", snapshotDate] = process.argv.slice(2);
if (snapshotDate && !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) throw new Error("Snapshot date must be YYYY-MM-DD.");
const xml = readFileSync(resolve(input), "utf8");
const dataset = importWalkways(xml, { snapshotDate });
dataset.metadata.sourceSha256 = createHash("sha256").update(xml).digest("hex");
writeFileSync(resolve(output), JSON.stringify(dataset) + "\n");
console.log(JSON.stringify(dataset.metadata, null, 2));
