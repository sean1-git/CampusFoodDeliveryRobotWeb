/**
 * Deployment entry point for a host providing DB and ASSETS bindings.
 * Routes API requests to the shared handler and other requests to built static files.
 */
import { handleApi, secureResponse } from "./api.mjs";
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/"))
      return secureResponse(await handleApi(request, env));
    const response = await env.ASSETS.fetch(request);
    const result = secureResponse(response);
    if (url.pathname === "/sw.js" || url.pathname.endsWith(".webmanifest"))
      result.headers.set("Cache-Control", "no-cache");
    return result;
  },
};
