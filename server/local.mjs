/**
 * Local Node server for development and the built demo. Serves dist/client,
 * sends /api requests to the shared handler, and opens the local SQLite database.
 */
import { createServer } from "node:http";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { Readable } from "node:stream";
import { handleApi, secureResponse } from "./api.mjs";
import { openDatabase } from "./local-db.mjs";
import { createRequestUrlResolver, InvalidRequestUrl } from "./request-url.mjs";

import { staticBody } from "./static-assets.mjs";

const requestUrl = createRequestUrlResolver(process.env);

mkdirSync(new URL("../.data/", import.meta.url), { recursive: true });
const DB = openDatabase(
  new URL("../.data/campus-demo.sqlite", import.meta.url).pathname.replace(
    /^\/([A-Z]:)/i,
    "$1",
  ),
);
const root = resolve("dist/client");
const types = {
  ".html": "text/html",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = requestUrl(incoming);
    let response;
    if (url.pathname.startsWith("/api/")) {
      const init = { method: incoming.method, headers: incoming.headers };
      if (!["GET", "HEAD"].includes(incoming.method)) {
        init.body = Readable.toWeb(incoming);
        init.duplex = "half";
      }
      response = await handleApi(new Request(url, init), {
        DB,
        INTEGRATION_MODE: process.env.INTEGRATION_MODE || "demo",
        CANONICAL_ORIGIN: process.env.CANONICAL_ORIGIN,
        NODE_ENV: process.env.NODE_ENV,
        GOOGLE_MAPS_BROWSER_KEY: process.env.GOOGLE_MAPS_BROWSER_KEY,
        // Vite serves the UI on 5173 and proxies API calls to this server.
        ALLOWED_ORIGINS:
          process.env.ALLOWED_ORIGINS ||
          process.env.ALLOWED_ORIGIN ||
          (process.env.NODE_ENV === "production" ? "" : "http://localhost:5173,http://127.0.0.1:5173"),
      });
    } else {
      let file = resolve(root, "." + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + sep) && file !== root) {
        outgoing.writeHead(403);
        outgoing.end();
        return;
      }
      if (!existsSync(file) || statSync(file).isDirectory())
        file = resolve(root, "index.html");
      const headers = {
        "Content-Type": types[extname(file)] || "application/octet-stream",
        "Cache-Control": /[\\/]assets[\\/]/.test(file)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      };
      response = existsSync(file)
        ? new Response(staticBody(file, incoming.headers["accept-encoding"], headers), { headers })
        : new Response("Run npm run build before npm start.", { status: 503 });
    }
    const secured = secureResponse(response);
    outgoing.writeHead(secured.status, Object.fromEntries(secured.headers));
    outgoing.end(Buffer.from(await secured.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(error instanceof InvalidRequestUrl ? 400 : 500, {
      "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    });
    outgoing.end(error instanceof InvalidRequestUrl ? "Invalid request URL or proxy headers."
      : "The local server could not handle this request.");
  }
});
server.listen(port, host, () =>
  console.log(`Campus Store demo: http://${host}:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      DB.close();
      process.exit(0);
    }),
  );
