/**
 * HTTP helpers shared by the API and server entry points: JSON responses,
 * bounded JSON-body reads, and browser security headers.
 */
export const json = (value, status = 200, extra = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extra,
    },
  });

export const JSON_BODY_TIMEOUT_MS = 10000;

export async function readSmallJson(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("JSON_REQUIRED");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_JSON");
  let rejectRead, complete = false;
  const interrupted = new Promise((_, reject) => { rejectRead = reject; });
  const onAbort = () => rejectRead(new Error("REQUEST_ABORTED"));
  // Limit the whole upload, including a stream that sends a few bytes then stalls.
  // This applies only to JSON request bodies, never long-lived SSE responses.
  const timer = setTimeout(() => rejectRead(new Error("REQUEST_TIMEOUT")), JSON_BODY_TIMEOUT_MS);
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  try {
    let size = 0;
    const chunks = [];
    while (true) {
      const { value, done } = await Promise.race([interrupted, reader.read()]);
      if (done) { complete = true; break; }
      size += value.length;
      if (size > 8192) throw new Error("TOO_LARGE");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("INVALID_JSON");
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    // Do not await a stalled producer's cancellation; its failure must not hide
    // the original timeout/abort or create an unhandled rejection.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://maps.googleapis.com https://maps.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com; connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com; font-src 'self' https://fonts.gstatic.com; worker-src 'self' blob:; frame-src https://*.google.com; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
  );
  return new Response(response.body, { status: response.status, headers });
}
