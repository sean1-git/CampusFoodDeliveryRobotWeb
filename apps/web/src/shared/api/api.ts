/**
 * Shared JSON request helper for the demo API. Sends same-origin session cookies,
 * skips the browser cache, times out requests, and preserves HTTP errors for checkout.
 */
import { createReadGate, retryAfterMs } from "./readGate";

const read = createReadGate();
export function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  // Never merge account reads across a cookie replacement. Account/checkout hooks
  // already coordinate those requests using an explicit session epoch.
  const publicRead = path === "/api/catalog" || path === "/api/maps-config";
  return !options && publicRead ? read(path, () => sendJson<T>(path)) : sendJson<T>(path, options);
}
async function sendJson<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = import.meta.env.MODE === "native"
    ? await (await import("./nativeApi")).nativeApiResponse(path, options)
    : await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
    ...options,
  });
  const data = await response
    .json()
    .catch(() => ({ error: "The store returned an unexpected response." }));
  if (!response.ok)
    throw Object.assign(new Error(data.error || "Please try again."), {
      status: response.status,
      code: data.code,
      retryAfterMs: retryAfterMs(response.headers.get("Retry-After")),
    });
  const succeededAt = Date.now();
  try { localStorage.setItem("campus-last-api-success", String(succeededAt)); } catch { /* Storage is optional. */ }
  window.dispatchEvent(new CustomEvent("campus-api-success", { detail: succeededAt }));
  return data;
}
