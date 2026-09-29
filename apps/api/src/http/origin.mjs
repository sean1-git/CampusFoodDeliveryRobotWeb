// Configuration is an origin, never a redirect URL or a path prefix.
export function canonicalOrigin(value, production = false) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value)) {
    throw new Error("CANONICAL_ORIGIN must contain only an absolute HTTP(S) origin.");
  }
  let url;
  try { url = new URL(value); } catch { throw new Error("CANONICAL_ORIGIN must be an absolute HTTP(S) origin."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash
    || (production && url.protocol !== "https:")) {
    throw new Error("CANONICAL_ORIGIN must contain only a scheme and host (HTTPS in production).");
  }
  return url.origin;
}
