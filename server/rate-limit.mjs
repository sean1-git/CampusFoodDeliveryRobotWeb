// In-memory abuse bounds for each API database binding. This is not a shared
// edge/distributed limit; it deliberately does not trust client IP headers.
export const RATE_LIMITS = Object.freeze({
  session: Object.freeze({ burst: 60, refillMs: 1000 }),
  checkout: Object.freeze({ burst: 20, refillMs: 3000 }),
  maxAccounts: 1024,
});

export function createRateLimiter({ clock = () => performance.now(), maxAccounts = RATE_LIMITS.maxAccounts } = {}) {
  if (!Number.isInteger(maxAccounts) || maxAccounts < 1) throw new Error("Invalid rate-limit capacity.");
  const accounts = new Map();
  let lastTime = 0, sessions;
  const currentTime = () => (lastTime = Math.max(lastTime, clock()));
  const fresh = (policy, now) => ({ tokens: policy.burst, updatedAt: now });
  function refill(bucket, policy, now) {
    bucket.tokens = Math.min(policy.burst, bucket.tokens + (now - bucket.updatedAt) / policy.refillMs);
    bucket.updatedAt = now;
  }
  function consume(bucket, policy, now) {
    refill(bucket, policy, now);
    if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) * policy.refillMs / 1000));
    bucket.tokens--;
    return 0;
  }
  return {
    session() {
      const now = currentTime();
      sessions ??= fresh(RATE_LIMITS.session, now);
      return consume(sessions, RATE_LIMITS.session, now);
    },
    checkout(accountId, requestKey) {
      const now = currentTime(), policy = RATE_LIMITS.checkout;
      let bucket = accounts.get(accountId);
      if (!bucket) {
        // Expire only fully replenished entries. Evicting an active bucket would
        // let rotating accounts reset their allowance and bypass the limit.
        let availableIn = Infinity;
        for (const [id, entry] of accounts) {
          refill(entry, policy, now);
          if (entry.tokens === policy.burst) accounts.delete(id);
          else availableIn = Math.min(availableIn, (policy.burst - entry.tokens) * policy.refillMs);
        }
        if (accounts.size >= maxAccounts) return Math.max(1, Math.ceil(availableIn / 1000));
        bucket = { ...fresh(policy, now), requests: new Map() };
        accounts.set(accountId, bucket);
      }
      // Concurrent retries can arrive before the queue INSERT becomes visible.
      // Remember charged keys for one full refill window; at most twice the
      // burst can be admitted during that window, so this cache stays bounded.
      for (const [key, chargedAt] of bucket.requests)
        if (now - chargedAt >= policy.burst * policy.refillMs) bucket.requests.delete(key);
      if (requestKey && bucket.requests.has(requestKey)) return 0;
      const retryAfter = consume(bucket, policy, now);
      if (!retryAfter && requestKey) bucket.requests.set(requestKey, now);
      return retryAfter;
    },
  };
}

const databases = new WeakMap();
export function rateLimiterFor(db, options) {
  let limiter = databases.get(db);
  if (!limiter) { limiter = createRateLimiter(options); databases.set(db, limiter); }
  return limiter;
}
