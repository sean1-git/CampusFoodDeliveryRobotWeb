import { BlockList, isIP } from "node:net";
import { canonicalOrigin } from "./origin.mjs";

export class InvalidRequestUrl extends Error {}

function proxyTrust(setting = "false") {
  if (setting === "false" || setting === "") return () => false;
  // Enable only when ingress is restricted to a proxy that OVERWRITES the header.
  if (setting === "true") return () => true;
  const peers = new BlockList();
  for (const entry of setting.split(",").map((value) => value.trim())) {
    if (entry === "loopback") {
      peers.addSubnet("127.0.0.0", 8, "ipv4");
      peers.addAddress("::1", "ipv6");
    } else {
      const family = isIP(entry);
      if (!family) throw new Error("TRUST_PROXY must be false, true, loopback, or a comma-separated list of proxy IP addresses.");
      peers.addAddress(entry, family === 6 ? "ipv6" : "ipv4");
    }
  }
  return (address) => {
    if (!address) return false;
    const family = isIP(address);
    return !!family && peers.check(address, family === 6 ? "ipv6" : "ipv4");
  };
}

// Validate deployment settings once at startup. Canonical origin takes priority
// over all request headers; forwarded hosts and Origin never construct URLs.
export function createRequestUrlResolver(env = {}) {
  const canonical = canonicalOrigin(env.CANONICAL_ORIGIN, env.NODE_ENV === "production");
  const trustedProxy = proxyTrust(env.TRUST_PROXY);
  return (incoming) => {
    const target = incoming.url;
    if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")
      || /[\\\s#]/.test(target)
      || [...target].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new InvalidRequestUrl("Invalid request target.");
    }
    let origin = canonical;
    if (!origin) {
      let protocol = incoming.socket?.encrypted ? "https" : "http";
      const forwarded = incoming.headers["x-forwarded-proto"];
      if (trustedProxy(incoming.socket?.remoteAddress) && forwarded !== undefined) {
        // Do not guess which hop to trust in an ambiguous/attacker-prepended list.
        if (forwarded !== "http" && forwarded !== "https") {
          throw new InvalidRequestUrl("Invalid forwarded protocol.");
        }
        protocol = forwarded;
      }
      const host = incoming.headers.host;
      if (typeof host !== "string" || !host || /[^a-zA-Z0-9.\-:[\]]/.test(host)) {
        throw new InvalidRequestUrl("Invalid request host.");
      }
      try { origin = new URL(`${protocol}://${host}`).origin; }
      catch { throw new InvalidRequestUrl("Invalid request host."); }
    }
    return new URL(target, origin);
  };
}
