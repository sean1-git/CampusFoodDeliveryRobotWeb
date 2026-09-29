type EventStream = {
  addEventListener: (type: string, listener: () => void) => void;
  close: () => void;
};
type CancelTimer = () => void;
export type OrderUpdateState = {
  sessionKey: string | null;
  online: boolean;
  visible: boolean;
  activeOrders: boolean;
  checkout: boolean;
};
type Options = {
  // Native HTTP uses a separate cookie jar, so native callers omit this transport.
  connect?: () => EventStream;
  refresh: (invalidate: boolean) => void | Promise<unknown>;
  reconcileCheckout: () => void;
  sessionExpired: () => void;
  timer?: (callback: () => void, delay: number) => CancelTimer;
  random?: () => number;
};

/** Account-scoped invalidations replace polling while the event stream is healthy. */
export function createOrderUpdates(options: Options) {
  const timer = options.timer ?? ((callback, delay) => {
    const id = setTimeout(callback, delay);
    return () => clearTimeout(id);
  });
  const random = options.random ?? Math.random;
  let state: OrderUpdateState = { sessionKey: null, online: false, visible: false, activeOrders: false, checkout: false };
  let source: EventStream | null = null;
  let generation = 0, failures = 0, lifecycle = 0, snapshotVersion = 0, snapshotFailures = 0;
  let healthy = false, expired = false, stopped = false, recoveringSession = false;
  let retry: CancelTimer | null = null, deadline: CancelTimer | null = null;
  let poll: CancelTimer | null = null, checkoutPoll: CancelTimer | null = null;
  let snapshotRetry: CancelTimer | null = null;
  const running = () => !stopped && !expired && !!state.sessionKey && state.online && state.visible;
  const recovering = () => !stopped && recoveringSession && !state.sessionKey && state.online && state.visible;
  const pollDelay = () => state.activeOrders || state.checkout ? 5000 : 30000;
  const retryDelay = (attempt: number) => Math.min(60000,
    Math.round(Math.min(60000, 2000 * 2 ** Math.min(attempt, 5)) * (0.75 + random() * 0.5)));

  function requestSnapshot(invalidate: boolean) {
    if (!running() && !recovering()) return;
    snapshotRetry?.(); snapshotRetry = null;
    const version = ++snapshotVersion, epoch = lifecycle;
    const current = () => (running() || recovering()) && version === snapshotVersion && epoch === lifecycle;
    const succeeded = () => { if (current()) snapshotFailures = 0; };
    const rejected = () => {
      if (!current()) return;
      snapshotRetry = timer(() => { snapshotRetry = null; requestSnapshot(true); }, retryDelay(snapshotFailures++));
    };
    try {
      const result = options.refresh(invalidate);
      if (result && typeof result.then === "function") void result.then(succeeded, rejected);
      else succeeded();
    } catch { rejected(); }
  }

  function closeSource() {
    generation++;
    source?.close(); source = null;
    deadline?.(); deadline = null;
    healthy = false;
  }
  function clearTimers() {
    retry?.(); retry = null;
    poll?.(); poll = null;
    checkoutPoll?.(); checkoutPoll = null;
    snapshotRetry?.(); snapshotRetry = null;
  }
  function maintainTimers() {
    if (!running()) return;
    if (healthy) { poll?.(); poll = null; }
    else if (!poll) poll = timer(() => {
      poll = null;
      if (!running()) return;
      requestSnapshot(false);
      maintainTimers();
    }, pollDelay());
    if (!state.checkout) { checkoutPoll?.(); checkoutPoll = null; }
    else if (!checkoutPoll) checkoutPoll = timer(() => {
      checkoutPoll = null;
      if (!running()) return;
      options.reconcileCheckout();
      maintainTimers();
    }, 5000);
  }
  function failed() {
    closeSource();
    if (!running()) return;
    maintainTimers();
    // Close EventSource's automatic retry before scheduling our own bounded retry.
    const delay = retryDelay(failures++);
    retry = timer(() => { retry = null; open(); }, delay);
  }
  function open() {
    if (!running() || !options.connect || source || retry) return;
    const epoch = ++generation;
    try {
      const connection = options.connect();
      source = connection;
      const current = () => running() && generation === epoch && source === connection;
      const touch = () => {
        deadline?.();
        // Named heartbeats are observable; comments cannot detect a half-open stream.
        deadline = timer(() => { if (current()) failed(); }, healthy ? 70000 : 15000);
      };
      connection.addEventListener("ready", () => {
        if (!current() || healthy) return;
        healthy = true; failures = 0;
        touch();
        maintainTimers();
        // Re-snapshot after subscribing: changes may have occurred while disconnected.
        requestSnapshot(true);
      });
      connection.addEventListener("change", () => { if (current()) { touch(); requestSnapshot(true); } });
      connection.addEventListener("heartbeat", () => { if (current()) touch(); });
      connection.addEventListener("session-expired", () => {
        if (!current()) return;
        expired = true;
        closeSource(); clearTimers();
        state = { ...state, sessionKey: null };
        lifecycle++;
        recoveringSession = true;
        options.sessionExpired();
        requestSnapshot(true);
      });
      connection.addEventListener("error", () => { if (current()) failed(); });
      // A proxy can open a socket without ever delivering the ready event.
      touch();
    } catch { failed(); }
  }
  function update(next: OrderUpdateState) {
    if (stopped) return;
    const wasRecovering = recovering();
    const sessionChanged = state.sessionKey !== next.sessionKey;
    const previousDelay = pollDelay();
    if (sessionChanged) {
      lifecycle++;
      closeSource(); clearTimers();
      failures = 0; snapshotFailures = 0; expired = false; recoveringSession = false;
    }
    state = next;
    if (!running()) {
      closeSource();
      if (recovering()) {
        if (!wasRecovering) requestSnapshot(true);
      } else { lifecycle++; clearTimers(); }
      return;
    }
    if (previousDelay !== pollDelay()) { poll?.(); poll = null; }
    open(); maintainTimers();
  }
  return {
    update,
    // Stop old-account events immediately, before React commits the new session.
    resetSession: () => update({ ...state, sessionKey: null }),
    stop: () => { stopped = true; lifecycle++; closeSource(); clearTimers(); },
  };
}
