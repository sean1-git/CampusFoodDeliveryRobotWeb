// Compress at build time so requests do not spend CPU recompressing static assets.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
const root = resolve("dist/client");
for (const file of readdirSync(root, { recursive: true })) {
  if (!/\.(html|css|js|svg|json|webmanifest)$/.test(file)) continue;
  const path = resolve(root, file), bytes = readFileSync(path);
  writeFileSync(path + ".br", brotliCompressSync(bytes));
  writeFileSync(path + ".gz", gzipSync(bytes));
}
