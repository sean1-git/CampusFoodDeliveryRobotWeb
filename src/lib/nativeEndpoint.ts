// Never allow API calls (or their credentials) to escape the configured HTTPS origin.
export function nativeEndpoint(path: string, origin: string) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash)
    throw new Error("Native API origin must be an HTTPS origin without a path or credentials.");
  if (!path.startsWith("/api/") || path.includes("\\") || path.includes("#"))
    throw new Error("Invalid native API path.");
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) throw new Error("Invalid native API path.");
  return url;
}
