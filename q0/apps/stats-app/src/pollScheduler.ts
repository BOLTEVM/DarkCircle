// A small, framework-free poller: run a fetch now, then every `intervalMs`, without ever overlapping itself.
//
// Rules it keeps (each is a bug a naive setInterval(fetch) has):
//  * One request at a time. A tick, a manual refresh and a visibility event that arrive while a request is in flight
//    all join it; none starts a second one.
//  * A late answer is dropped. stop() aborts the in-flight request and bumps a generation, so a reply that arrives
//    after unmount (or after a newer request superseded it) can never write state.
//  * Hidden tabs and offline browsers do not poll. The timer still fires, notices, and goes idle; becoming visible or
//    online runs a fetch immediately when one is due. (The very first fetch is the one exception for a hidden tab: a
//    value is better ready before anyone looks.)
//  * A failure keeps the last good value (never blanks it), marks it stale, and retries on an exponential backoff;
//    the first success resets the backoff.
//  * Status is derived, not stored: loading (nothing yet), live (fresh), stale (old or the last try failed), error
//    (nothing to show and the last try failed). A timer flips live to stale when a value ages out with no new fetch.
//
// No imports and no DOM or React types: node:test drives it with fake timers (see test/pollScheduler.test.ts).

export type PollStatus = 'loading' | 'live' | 'stale' | 'error';
export type PollReason = 'initial' | 'schedule' | 'visible' | 'online' | 'manual' | 'resume';

export interface PollState<T> {
  data: T | null;
  status: PollStatus;
  /** When `data` was last fetched successfully (ms since epoch), or null. */
  updatedAt: number | null;
  /** The last failure's message; cleared by the next success. */
  error: string | null;
  /** Consecutive failures since the last success. */
  failures: number;
  inFlight: boolean;
  /** When the next scheduled fetch is due, or null while idle (hidden, offline, inactive, stopped). */
  nextRunAt: number | null;
}

export interface PollEnv {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** 0..1, for jitter. */
  random(): number;
  isHidden(): boolean;
  isOnline(): boolean;
}

export interface PollContext<T> {
  signal: AbortSignal;
  /** The last good value, so a partial failure can keep the part that did not change. */
  previous: T | null;
  reason: PollReason;
}

export interface PollerOptions<T> {
  fetch: (ctx: PollContext<T>) => Promise<T>;
  intervalMs: number;
  /** A value older than this is "stale" even without a failure. Default: 2 intervals plus 5 s. */
  staleAfterMs?: number;
  /** First retry delay after a failure; doubles each time. Default: min(10 s, interval). */
  retryBaseMs?: number;
  /** Longest wait between retries. Default: 5 min (never less than the interval). */
  maxBackoffMs?: number;
  /** 0..1: each delay varies by up to this fraction either way, so many tabs do not poll in step. Default 0. */
  jitter?: number;
  /** A value already known (a cached profile): shown at once, and not re-fetched until it is due. */
  initial?: { data: T; updatedAt: number } | null;
  env?: Partial<PollEnv>;
  onState?: (state: PollState<T>) => void;
}

export interface Poller<T> {
  /** Begin: fetch now (unless the seeded value is still fresh), then keep polling. Safe to call again after stop(). */
  start(): void;
  /** Cancel the timer and the in-flight request, and ignore any reply that still arrives. */
  stop(): void;
  /** Fetch now, whatever the backoff, visibility or schedule (a person asked). Joins a request already in flight. */
  refresh(): Promise<void>;
  /** The page became visible or hidden: resume (and fetch if one is due) on visible. */
  visibilityChanged(): void;
  /** The browser went online or offline. Online runs a fetch now if the last one failed or the value is stale. */
  networkChanged(online: boolean): void;
  /** false: no more polling on a timer (a tab nobody is looking at; the value and the first fetch are kept); true: resume, fetching if due. */
  setActive(active: boolean): void;
  getState(): PollState<T>;
}

// ------------------------------------------------------------------------------------------------ pure helpers

export const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

/** Delay before the next try after `failures` consecutive failures (1 = the first). Doubles, capped. */
export function backoffDelay(failures: number, retryBaseMs: number, maxBackoffMs: number): number {
  if (failures <= 0) return retryBaseMs;
  const exp = Math.min(failures - 1, 30);
  return Math.min(maxBackoffMs, retryBaseMs * 2 ** exp);
}

/** Spread `delay` by up to +-`jitter` (0..1) using a 0..1 random draw; never negative. */
export function withJitter(delay: number, jitter: number, random: number): number {
  if (!(jitter > 0)) return delay;
  const j = Math.min(1, jitter);
  return Math.max(0, Math.round(delay * (1 + j * (2 * random - 1))));
}

export function deriveStatus(i: {
  hasData: boolean;
  updatedAt: number | null;
  now: number;
  staleAfterMs: number;
  lastFailed: boolean;
}): PollStatus {
  if (!i.hasData) return i.lastFailed ? 'error' : 'loading';
  if (i.lastFailed) return 'stale';
  if (i.updatedAt === null || i.now - i.updatedAt > i.staleAfterMs) return 'stale';
  return 'live';
}

/** "just now", "12 s ago", "3 min ago", "2 h ago": the figure a person reads next to a number that may have aged. */
export function describeAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'not yet';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

const errorMessage = (e: unknown): string => {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : typeof e === 'string' && e ? e : 'The request failed.';
};

// ------------------------------------------------------------------------------------------------ the poller

function defaultEnv(): PollEnv {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: () => Math.random(),
    isHidden: () => typeof document !== 'undefined' && document.hidden === true,
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false
  };
}

export function createPoller<T>(options: PollerOptions<T>): Poller<T> {
  const env: PollEnv = { ...defaultEnv(), ...(options.env ?? {}) };
  const interval = Math.max(1, options.intervalMs);
  const staleAfter = options.staleAfterMs ?? interval * 2 + 5_000;
  const retryBase = Math.max(1, options.retryBaseMs ?? Math.min(10_000, interval));
  const maxBackoff = Math.max(interval, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
  const jitter = options.jitter ?? 0;

  let data: T | null = options.initial ? options.initial.data : null;
  let updatedAt: number | null = options.initial ? options.initial.updatedAt : null;
  let error: string | null = null;
  let failures = 0;
  let running = false; // start() called and not stopped
  let active = true;
  let nextRunAt: number | null = null;
  let timer: unknown = null;
  let staleTimer: unknown = null;
  let generation = 0;
  let current: { promise: Promise<void>; controller: AbortController } | null = null;

  const getState = (): PollState<T> => ({
    data,
    status: deriveStatus({ hasData: data !== null, updatedAt, now: env.now(), staleAfterMs: staleAfter, lastFailed: failures > 0 }),
    updatedAt,
    error,
    failures,
    inFlight: current !== null,
    nextRunAt
  });

  const emit = () => options.onState?.(getState());

  const clearTimer = () => {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  };
  const clearStaleTimer = () => {
    if (staleTimer !== null) env.clearTimeout(staleTimer);
    staleTimer = null;
  };

  /** Flip live to stale when the value ages out with no new fetch to say otherwise. */
  const armStaleTimer = () => {
    clearStaleTimer();
    if (data === null || updatedAt === null || failures > 0) return;
    const remaining = updatedAt + staleAfter - env.now();
    staleTimer = env.setTimeout(() => {
      staleTimer = null;
      if (running) emit();
    }, Math.max(0, remaining) + 1);
  };

  const canPoll = () => running && active && !env.isHidden() && env.isOnline();
  const nextDelay = () => (failures === 0 ? interval : backoffDelay(failures, retryBase, maxBackoff));

  const run = (reason: PollReason): Promise<void> => {
    if (!running) return Promise.resolve();
    if (current) return current.promise; // never overlap
    clearTimer();
    nextRunAt = null;
    const controller = new AbortController();
    const mine = ++generation;
    let done: () => void = () => {};
    const entry = { promise: new Promise<void>(resolve => (done = resolve)), controller };
    current = entry;

    void (async () => {
      try {
        const next = await options.fetch({ signal: controller.signal, previous: data, reason });
        if (mine !== generation || controller.signal.aborted) return; // late: stop() already cleared everything
        data = next;
        updatedAt = env.now();
        error = null;
        failures = 0;
      } catch (e) {
        if (mine !== generation || controller.signal.aborted) return;
        failures += 1;
        error = errorMessage(e);
      }
      if (current === entry) current = null;
      schedule(nextDelay());
      armStaleTimer();
      emit();
    })().finally(() => {
      if (current === entry) current = null;
      done();
    });

    emit();
    return entry.promise;
  };

  function schedule(delay: number) {
    clearTimer();
    if (!running || !active) {
      nextRunAt = null;
      return;
    }
    const wait = withJitter(delay, jitter, env.random());
    nextRunAt = env.now() + wait;
    timer = env.setTimeout(onTimer, wait);
  }

  function onTimer() {
    timer = null;
    if (!running || !active) {
      nextRunAt = null;
      return;
    }
    if (!canPoll()) {
      // hidden or offline: no request; the visibility or online event resumes it
      nextRunAt = null;
      emit();
      return;
    }
    void run('schedule');
  }

  const networkChanged = (online: boolean) => {
    if (!running || !online || env.isHidden() || !active) return;
    const due = nextRunAt === null || env.now() >= nextRunAt || failures > 0;
    if (due && !current) void run(failures > 0 ? 'online' : 'visible');
    else emit();
  };

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      error = null;
      const age = updatedAt === null ? null : env.now() - updatedAt;
      if (data !== null && age !== null && age < interval) {
        // a seeded value that is still fresh: show it and wait out the rest of the interval
        schedule(interval - age);
        armStaleTimer();
        emit();
        return;
      }
      // One fetch happens even while inactive or hidden (a value ready before anyone looks); only an offline browser
      // waits. Timers, and every later fetch, respect visibility and `active`.
      if (!env.isOnline()) {
        nextRunAt = null;
        emit();
        return;
      }
      void run('initial');
    },

    stop() {
      running = false;
      generation++;
      current?.controller.abort();
      current = null;
      clearTimer();
      clearStaleTimer();
      nextRunAt = null;
    },

    refresh() {
      if (!running) return Promise.resolve();
      return run('manual');
    },

    visibilityChanged() {
      if (!running || env.isHidden()) return;
      networkChanged(env.isOnline());
    },

    networkChanged,

    setActive(next: boolean) {
      if (active === next) return;
      active = next;
      if (!running) return;
      if (!active) {
        clearTimer();
        nextRunAt = null;
        emit();
        return;
      }
      if (!canPoll() || current) return;
      const age = updatedAt === null ? null : env.now() - updatedAt;
      if (data === null || age === null || age >= interval || failures > 0) void run('resume');
      else schedule(interval - age);
    },

    getState
  };
}
