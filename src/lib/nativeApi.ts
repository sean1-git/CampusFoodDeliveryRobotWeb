import { CapacitorHttp } from "@capacitor/core";
import { nativeEndpoint } from "./nativeEndpoint";

export async function nativeApiResponse(path: string, options: RequestInit = {}) {
  const url = nativeEndpoint(path, import.meta.env.VITE_NATIVE_API_ORIGIN
    || "https://projectdemo-250283665537.europe-west1.run.app");
  const headers = new Headers(options.headers);
  // Native HTTP has no browser Origin. Use the configured API origin; the server
  // still requires its account session cookie, CSRF token and idempotency key.
  headers.set("Origin", url.origin);
  headers.set("Cache-Control", "no-store");
  if (options.body != null && typeof options.body !== "string") throw new Error("Only JSON API bodies are supported.");
  // Capacitor's native cookie jar handles HttpOnly session cookies, not localStorage.
  const result = await CapacitorHttp.request({
    url: url.href, method: options.method || "GET",
    headers: Object.fromEntries(headers.entries()),
    data: options.body ? JSON.parse(options.body as string) : undefined,
    responseType: "json", connectTimeout: 12000, readTimeout: 12000, disableRedirects: true,
  });
  // Preserve HTTP status handling without exposing response cookies to app code.
  return new Response(JSON.stringify(result.data), { status: result.status,
    headers: { "Content-Type": "application/json" } });
}
