// Serialize reads and repeat after an invalidation during an in-flight read.
// An order event must not be satisfied by a response started before the order.
export function createRefreshQueue(read: () => Promise<void>) {
  let running: Promise<void> | null = null;
  let dirty = false;
  return (invalidate = true) => {
    // Wake/startup reads can share work; mutations must refresh again afterward.
    if (running && !invalidate) return running;
    dirty = true;
    if (!running) {
      running = (async () => {
        try {
          do {
            dirty = false;
            await read();
          } while (dirty);
        } finally { running = null; }
      })();
    }
    return running;
  };
}
