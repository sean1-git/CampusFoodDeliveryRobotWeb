/**
 * Shared JSON request helper for the demo API. Sends same-origin session cookies,
 * skips the browser cache, times out requests, and preserves HTTP errors for checkout.
 */
export async function requestJson<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
    ...options,
  });
  const data = await response
    .json()
    .catch(() => ({ error: "The store returned an unexpected response." }));
  if (!response.ok)
    throw Object.assign(new Error(data.error || "Please try again."), {
      status: response.status,
    });
  return data;
}
