type ReadError = Error & { status?: number; retryAfterMs?: number };

// No response cache: wallet, stock and order data always come from the server.
// Merge concurrent identical reads and suppress repeated reads during outages.
export function createReadGate(now = Date.now, random = Math.random) {
  const pending = new Map<string, Promise<unknown>>();
  const failures = new Map<string, { count: number; until: number; error: ReadError }>();
  return function read<T>(key: string, run: () => Promise<T>): Promise<T> {
    const active = pending.get(key);
    if (active) return active as Promise<T>;
    const previous = failures.get(key);
    if (previous && now() < previous.until) return Promise.reject(previous.error);
    const task = Promise.resolve().then(run).then(value => {
      failures.delete(key);
      return value;
    }, (error: ReadError) => {
      if (!error.status || error.status === 429 || error.status >= 500) {
        const count = (previous?.count ?? 0) + 1;
        const delay = Math.max(error.retryAfterMs ?? 0,
          Math.min(60000, 2000 * 2 ** Math.min(count - 1, 5)) * (0.8 + random() * 0.2));
        failures.delete(key);
        failures.set(key, { count, until: now() + delay, error });
        if (failures.size > 32) failures.delete(failures.keys().next().value!);
      } else failures.delete(key);
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}

export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 0;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(delay) ? Math.min(3600000, Math.max(0, delay)) : 0;
}

export const checkoutRetryDelay = (attempt: number) => Math.min(4000, 500 * 2 ** Math.min(attempt, 3));
