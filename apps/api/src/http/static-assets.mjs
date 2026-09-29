import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Cache only public static bytes, with a fixed memory budget. File metadata
// invalidates entries in development; deployed container files are immutable.
const files = new Map();
const etags = new WeakMap();
const MAX_BYTES = 8 * 1024 * 1024;
let cachedBytes = 0;
const fileVersion = metadata => `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
function readStaticFile(file) {
  // Open first, then inspect and read that exact descriptor. A path replaced
  // between metadata inspection and reading cannot substitute different bytes.
  const descriptor = openSync(file, "r");
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw Object.assign(new Error("Static asset is not a regular file."), { code: "EISDIR" });
    const version = fileVersion(metadata);
    const previous = files.get(file);
    if (previous?.version === version) {
      files.delete(file);
      files.set(file, previous);
      return previous.body;
    }
    if (previous) {
      cachedBytes -= previous.body.length;
      files.delete(file);
    }
    const body = readFileSync(descriptor);
    // Development tools may edit an open file in place. Do not retain bytes
    // under metadata that changed during the read.
    if (body.length <= MAX_BYTES && fileVersion(fstatSync(descriptor)) === version) {
      while (files.size >= 128 || cachedBytes + body.length > MAX_BYTES) {
        const oldest = files.keys().next().value;
        cachedBytes -= files.get(oldest).body.length;
        files.delete(oldest);
      }
      files.set(file, { version, body });
      cachedBytes += body.length;
    }
    return body;
  } finally { closeSync(descriptor); }
}

// Honor explicit q=0 exclusions and prefer Brotli when quality values tie.
export function acceptedEncodings(header = "") {
  const qualities = new Map(header.toLowerCase().split(",").map(part => {
    const [name, ...parameters] = part.trim().split(";");
    const parameter = parameters.find(value => value.trim().startsWith("q="));
    const quality = parameter ? Number(parameter.trim().slice(2)) : 1;
    return [name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0];
  }));
  return ["br", "gzip"].map(name => ({ name, quality: qualities.get(name) ?? qualities.get("*") ?? 0 }))
    .filter(value => value.quality > 0).sort((a, b) => b.quality - a.quality).map(value => value.name);
}
export function staticBody(file, acceptEncoding, headers) {
  headers.Vary = "Accept-Encoding";
  for (const encoding of acceptedEncodings(acceptEncoding)) {
    const compressed = file + (encoding === "br" ? ".br" : ".gz");
    try {
      const body = readStaticFile(compressed);
      headers["Content-Encoding"] = encoding;
      return body;
    } catch (error) {
      // A missing/removed precompressed sibling is normal; access/read errors
      // must not be disguised as successful compression negotiation.
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  return readStaticFile(file);
}

export function staticResponse(file, acceptEncoding, headers, { ifNoneMatch, method = "GET" } = {}) {
  const body = staticBody(file, acceptEncoding, headers);
  let etag = etags.get(body);
  if (!etag) {
    etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    etags.set(body, etag);
  }
  headers.ETag = etag;
  // Validators identify the selected representation, including compression.
  // Unversioned images/HTML still revalidate, so releases do not strand old UI.
  const unchanged = String(ifNoneMatch ?? "").split(",").some(value => {
    const tag = value.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
  if (["GET", "HEAD"].includes(method) && unchanged) return new Response(null, { status: 304, headers });
  headers["Content-Length"] = String(body.length);
  return new Response(method === "HEAD" ? null : body, { headers });
}
